// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@orkbot/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@orkbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RoutineWatchDeps } from "./routine-watch.js";
import { checkRoutineWatch } from "./routine-watch.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

describePostgres("relative watch dates (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: {
    userId: string;
    spaceId: string;
    botId: string;
    threadId: string;
  };
  const address = `routine-watch-dates-${randomUUID()}@orkbot.test`;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const { userId, spaceId, botId, threadId } = await runAsSystem(
      "relative watch dates fixture",
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

  it("uses the saved timezone on successive checks without replacing saved placeholders", async () => {
    const watch = {
      kind: "tool",
      tool: "calendar_list_events",
      args: {
        from: "{{today}}",
        range: [{ until: "{{today+2d}}", since: "{{today-7d}}" }],
      },
    };
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "Upcoming calendar changes",
        prompt: "Report changes",
        crons: [],
        timezone: "America/Los_Angeles",
        watch,
      },
    });
    const execute = vi.fn(async function* () {
      yield { type: "result" as const, data: [] };
    });
    const deps = {
      prisma: system,
      connector: {
        discoverTools: vi.fn(async () => [{ name: watch.tool, readOnly: true }]),
        execute,
      },
    } as unknown as RoutineWatchDeps;

    const first = await checkRoutineWatch(deps, routine, new Date("2026-11-20T00:30:00Z"));
    await system.routine.update({
      where: { id: routine.id },
      data: { watchState: first.state },
    });
    const saved = await system.routine.findUniqueOrThrow({
      where: { id: routine.id },
    });
    await checkRoutineWatch(deps, saved, new Date("2026-11-21T00:30:00Z"));

    expect(execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        args: {
          from: "2026-11-19",
          range: [{ until: "2026-11-21", since: "2026-11-12" }],
        },
      }),
      expect.anything(),
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        args: {
          from: "2026-11-20",
          range: [{ until: "2026-11-22", since: "2026-11-13" }],
        },
      }),
      expect.anything(),
    );
    expect((await system.routine.findUniqueOrThrow({ where: { id: routine.id } })).watch).toEqual(
      watch,
    );
  });
});
