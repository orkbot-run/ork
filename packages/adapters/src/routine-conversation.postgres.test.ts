// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { runContinueJob } from "@orkbot/adapter-kit";
import type { Prisma, PrismaClient } from "@orkbot/db";
import {
  asSystem,
  createDb,
  declareRunReaderVersion,
  provisionMessagingIdentity,
  runAsSystem,
} from "@orkbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";
import { lockRunConversation, mayClaimScheduledRoutine } from "./routine-conversation.js";
import { startNextWaitingRun } from "./run-lifecycle.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describePostgres("scheduled routine conversation claims (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `routine-conversation-${randomUUID()}@orkbot.test`;
  const now = new Date("2026-11-20T12:00:00Z");

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const { userId, spaceId, botId, threadId } = await runAsSystem(
      "routine conversation fixture",
      () =>
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
    const group = await system.chatGroup.create({
      data: {
        userId: identity.userId,
        spaceId: identity.spaceId,
        name: "Routine conversation fixture",
        members: { create: { botId: identity.botId } },
      },
    });
    const thread = await system.thread.create({
      data: { userId: identity.userId, spaceId: identity.spaceId, groupId: group.id },
    });
    const scope = { ...identity, threadId: thread.id };
    async function run(overrides: Partial<Prisma.RunUncheckedCreateInput> = {}) {
      const task = await system.task.create({
        data: {
          ...scope,
          botId: overrides.botId ?? scope.botId,
          threadId: overrides.threadId ?? scope.threadId,
          prompt: "fixture",
          status: "queued",
        },
      });
      return system.run.create({
        data: {
          ...scope,
          taskId: task.id,
          status: "queued",
          trigger: "routine",
          clientNonce: `routine-timer:${randomUUID()}:tick`,
          createdAt: now,
          ...overrides,
        },
      });
    }
    async function claim(
      candidate: Awaited<ReturnType<typeof run>>,
      beforeLock?: (tx: Prisma.TransactionClient) => Promise<void>,
    ) {
      return system.$transaction(async (tx) => {
        await declareRunReaderVersion(tx);
        await beforeLock?.(tx);
        await lockRunConversation(tx, candidate);
        if (!(await mayClaimScheduledRoutine(tx, candidate, now))) return false;
        await tx.run.update({
          where: { id: candidate.id },
          data: {
            status: "leased",
            leaseOwner: `worker-${candidate.id}`,
            leaseFence: 1,
            leaseExpiresAt: new Date(now.getTime() + 60_000),
          },
        });
        return true;
      });
    }
    return { group, thread, run, claim };
  }

  it.each(["leased", "running", "waiting_input", "waiting_takeover"])(
    "holds a routine behind a %s turn in the same conversation",
    async (status) => {
      const { run, claim } = await fixture();
      await run({
        trigger: "user",
        clientNonce: null,
        status,
        leaseExpiresAt: status.startsWith("waiting_") ? null : new Date(now.getTime() + 60_000),
      });
      expect(await claim(await run())).toBe(false);
    },
  );

  it.each([
    { status: "completed" },
    { status: "failed" },
    { status: "cancelled" },
    { status: "leased", leaseExpiresAt: now },
    { status: "running", leaseExpiresAt: new Date(now.getTime() - 1) },
    { status: "running", leaseExpiresAt: null },
    { status: "queued", wakeAt: new Date(now.getTime() + 60_000) },
  ])("ignores a terminal, expired, or deferred turn: %j", async (overrides) => {
    const { run, claim } = await fixture();
    await run({ createdAt: new Date(now.getTime() - 1_000), ...overrides });
    expect(await claim(await run())).toBe(true);
  });

  it("ignores active turns belonging to another bot or thread", async () => {
    const { group, run, claim } = await fixture();
    const otherBot = await system.bot.create({
      data: {
        userId: identity.userId,
        spaceId: identity.spaceId,
        name: "Other bot",
        color: "blue",
      },
    });
    await system.chatGroupMember.create({ data: { groupId: group.id, botId: otherBot.id } });
    await run({
      botId: otherBot.id,
      status: "waiting_input",
    });
    await run({
      threadId: identity.threadId,
      status: "running",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    });
    expect(await claim(await run())).toBe(true);
  });

  it.each(["routine-timer:", "routine-schedule:"])(
    "gives an earlier ready %s occurrence priority",
    async (prefix) => {
      const { run, claim } = await fixture();
      const suffix = randomUUID();
      const earlier = await run({
        id: `z-${suffix}`,
        createdAt: new Date(now.getTime() - 1_000),
        clientNonce: `${prefix}${randomUUID()}:earlier`,
        wakeAt: now,
      });
      const later = await run({ id: `a-${suffix}` });
      expect(await claim(later)).toBe(false);
      expect(await claim(earlier)).toBe(true);
    },
  );

  it("orders simultaneous claims by createdAt and then id", async () => {
    const { run, claim } = await fixture();
    const suffix = randomUUID();
    const first = await run({ id: `a-${suffix}` });
    const second = await run({ id: `b-${suffix}` });
    // Submit the later occurrence first: lock acquisition order must not determine priority.
    expect(await Promise.all([claim(second), claim(first)])).toEqual([false, true]);
    expect(await system.run.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({
      status: "queued",
      leaseFence: 0,
    });
  });

  it.each([true, false])(
    "leaves the candidate queued while another turn is running (scheduled candidate: %s)",
    async (scheduled) => {
      const { run } = await fixture();
      await run({
        ...(scheduled ? { trigger: "user", clientNonce: null } : {}),
        status: "running",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      const candidate = await run(scheduled ? {} : { trigger: "user", clientNonce: null });
      const executor = createRunExecutor({ prisma: system } as Parameters<
        typeof createRunExecutor
      >[0]);
      await executor.continueRun(candidate.id, "waiting-worker");
      expect(await system.run.findUniqueOrThrow({ where: { id: candidate.id } })).toMatchObject({
        status: "queued",
        leaseFence: 0,
        wakeAt: null,
      });
    },
  );

  it("does not give queued user, manual, or legacy routine runs scheduled priority", async () => {
    const { run, claim } = await fixture();
    for (const overrides of [
      { trigger: "user", clientNonce: `routine-timer:${randomUUID()}:user` },
      { clientNonce: `manual:${randomUUID()}` },
      { clientNonce: null },
    ]) {
      await run({ ...overrides, createdAt: new Date(now.getTime() - 1_000) });
    }
    expect(await claim(await run())).toBe(true);
  });

  it("rechecks the active turn after waiting for its conversation lock", async () => {
    const { run, claim } = await fixture();
    const active = await run({ status: "waiting_input" });
    const candidate = await run();
    const locked = signal();
    const finish = signal();
    const finalization = system.$transaction(
      async (tx) => {
        await lockRunConversation(tx, active);
        locked.resolve();
        await finish.promise;
        await tx.run.update({
          where: { id: active.id },
          data: { status: "completed", completedAt: now },
        });
      },
      { timeout: 15_000 },
    );
    await locked.promise;
    const started = signal();
    let claimingPid: number | undefined;
    const claiming = claim(candidate, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      claimingPid = rows[0]!.pid;
      started.resolve();
    });
    try {
      await started.promise;
      // Observe the real PostgreSQL lock wait before committing the terminal transition.
      await expect
        .poll(
          async () => {
            const rows = await system.$queryRaw<Array<{ waiting: boolean }>>`
              SELECT EXISTS (
                SELECT 1 FROM pg_locks
                WHERE pid = ${claimingPid}
                  AND locktype = 'advisory'
                  AND NOT granted
              ) AS waiting
            `;
            return rows[0]?.waiting;
          },
          { timeout: 3_000 },
        )
        .toBe(true);
    } finally {
      finish.resolve();
      await finalization;
    }
    expect(await claiming).toBe(true);
  });

  it("publishes an immediately runnable routine when the blocking turn ends during admission", async () => {
    const { run, claim } = await fixture();
    const active = await run({
      trigger: "user",
      clientNonce: null,
      status: "running",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    });
    const candidate = await run();
    const checked = signal();
    const releaseClaim = signal();
    const blocked = system.$transaction(async (tx) => {
      await declareRunReaderVersion(tx);
      await lockRunConversation(tx, candidate);
      const canClaim = await mayClaimScheduledRoutine(tx, candidate, now);
      checked.resolve();
      await releaseClaim.promise;
      return canClaim;
    });
    const enqueue = vi.fn(async () => undefined);
    try {
      await Promise.race([checked.promise, blocked]);
      await system.run.update({
        where: { id: active.id },
        data: { status: "completed", completedAt: now, leaseExpiresAt: null },
      });
      await startNextWaitingRun(
        { prisma: system, jobs: { enqueue, cancel: async () => {}, close: async () => {} } },
        active.botId,
        active.id,
        active.threadId,
      );
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob(candidate.id));
    } finally {
      releaseClaim.resolve();
      expect(await blocked).toBe(false);
    }
    expect(await system.run.findUniqueOrThrow({ where: { id: candidate.id } })).toMatchObject({
      status: "queued",
      wakeAt: null,
    });
    expect(await claim(candidate)).toBe(true);
  });
});
