import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@orkbot/db";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@orkbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  backOffRoutineAfterAccountError,
  clearRoutineBackoff,
  releaseUserRoutineAccountBackoffs,
  routineAccountBackoffMs,
} from "./routine-backoff.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

describePostgres("backing off a routine on refused model accounts (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `routine-backoff-${randomUUID()}@orkbot.test`;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const { userId, spaceId, botId, threadId } = await runAsSystem("routine backoff fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    identity = { userId, spaceId, botId, threadId };
  });

  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function fixture() {
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "Every minute",
        prompt: "fixture",
        crons: ["* * * * *"],
        active: true,
        nextRunAt: new Date(Math.ceil(Date.now() / 60_000) * 60_000),
      },
    });
    const enqueue = vi.fn(async () => undefined);
    const deps = { prisma: system, jobs: { enqueue, cancel: vi.fn(), close: vi.fn() } };
    return { routine, deps, enqueue };
  }

  it("counts every concurrent failure and holds the schedule for the last count", async () => {
    const { routine, deps } = await fixture();
    const now = new Date();

    await Promise.all(
      Array.from({ length: 4 }, () => backOffRoutineAfterAccountError(deps, routine.id, now)),
    );

    const row = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(row.accountFailures).toBe(4);
    expect(row.nextRunAt!.getTime()).toBeGreaterThanOrEqual(
      now.getTime() + routineAccountBackoffMs(4),
    );
    expect(row.nextRunAt!.getTime()).toBeLessThanOrEqual(
      now.getTime() + routineAccountBackoffMs(4) + 60_000,
    );
  });

  it("returns a held routine to its cadence once a run gets through", async () => {
    const { routine, deps } = await fixture();
    for (let count = 0; count < 3; count++) {
      await backOffRoutineAfterAccountError(deps, routine.id);
    }

    await clearRoutineBackoff(deps, routine.id);

    const row = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(row.accountFailures).toBe(0);
    expect(row.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("releases only the reconnecting user's holds and keeps paused routines paused", async () => {
    const { routine, deps, enqueue } = await fixture();
    const heldUntil = new Date(Date.now() + 24 * 60 * 60_000);
    await system.routine.update({
      where: { id: routine.id },
      data: { accountFailures: 8, nextRunAt: heldUntil },
    });
    const paused = await system.routine.create({
      data: {
        ...identity,
        name: "Paused",
        prompt: "fixture",
        crons: ["* * * * *"],
        active: false,
        accountFailures: 8,
        nextRunAt: heldUntil,
      },
    });
    const watch = await system.routine.create({
      data: {
        ...identity,
        name: "Watch",
        prompt: "fixture",
        crons: [],
        watch: { kind: "files" },
        active: true,
        accountFailures: 8,
        nextRunAt: heldUntil,
      },
    });
    const other = await system.routine.create({
      data: {
        ...identity,
        userId: `other-${randomUUID()}`,
        name: "Other owner",
        prompt: "fixture",
        crons: ["* * * * *"],
        active: true,
        accountFailures: 8,
        nextRunAt: heldUntil,
      },
    });
    const now = new Date();
    await runAsTenant(identity, () =>
      releaseUserRoutineAccountBackoffs({ ...deps, prisma: db.prisma }, identity.userId, now),
    );
    const [timerRow, pausedRow, watchRow, otherRow] = await Promise.all(
      [routine, paused, watch, other].map(({ id }) =>
        system.routine.findUniqueOrThrow({ where: { id } }),
      ),
    );
    expect(timerRow!.accountFailures).toBe(0);
    expect(timerRow!.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(timerRow!.nextRunAt!.getTime()).toBeLessThanOrEqual(now.getTime() + 60_000);
    expect(pausedRow).toMatchObject({ active: false, accountFailures: 0, nextRunAt: heldUntil });
    expect(watchRow).toMatchObject({ accountFailures: 0, nextRunAt: now });
    expect(otherRow).toMatchObject({ accountFailures: 8, nextRunAt: heldUntil });
    expect(enqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ routineId: paused.id }) }),
    );
    expect(enqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ routineId: other.id }) }),
    );
  });
});
