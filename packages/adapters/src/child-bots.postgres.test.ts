// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { PrismaClient } from "@orkbot/db";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  restoreBotWithRoutines,
  runAsSystem,
  runAsTenant,
} from "@orkbot/db";
import { expect, it, vi } from "vitest";
import { archiveBot } from "./child-bots.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";

const url = process.env.DATABASE_URL;

it.skipIf(process.env.VERIFY_DATABASE !== "1" || !url)(
  "archives a bot without overwriting runs that finish after the active-run lookup",
  async () => {
    const db = createDb(url!);
    const system = asSystem(db.prisma);
    const address = `archive-race-${randomUUID()}@orkbot.test`;
    const identity = await runAsSystem("create archive race fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const { spaceId, userId, botId, threadId } = identity;
    try {
      const fields = { spaceId, userId, botId, threadId };
      const startRun = async () => {
        const task = await system.task.create({
          data: { ...fields, prompt: "Fixture work", status: "running" },
        });
        return system.run.create({
          data: { ...fields, taskId: task.id, status: "running", trigger: "user" },
        });
      };
      const completed = await startRun();
      const failed = await startRun();
      const active = await startRun();
      const at = new Date(Date.now() + 2 * 60 * 60_000);
      const [armed, paused] = await Promise.all(
        [true, false].map((active) =>
          system.routine.create({
            data: {
              ...fields,
              name: "Reminder",
              prompt: "Notify",
              crons: ["@once"],
              active,
              nextRunAt: active ? at : null,
            },
          }),
        ),
      );
      const endedAt = new Date("2026-11-19T15:00:00.000Z");
      let raced = false;
      const prisma = db.prisma.$extends({
        query: {
          run: {
            async findMany({ args, query }) {
              const rows = await query(args);
              if (args.where?.botId !== botId || raced) return rows;
              expect(rows).toHaveLength(3);
              raced = true;
              // A different worker commits while the archive caller still holds its old rows.
              await system.$transaction(async (tx) => {
                for (const [run, status] of [
                  [completed, "completed"],
                  [failed, "failed"],
                ] as const) {
                  await tx.run.update({
                    where: { id: run.id },
                    data: { status, completedAt: endedAt },
                  });
                  await tx.task.update({ where: { id: run.taskId }, data: { status } });
                }
              });
              return rows;
            },
          },
        },
      }) as unknown as PrismaClient;
      const cancel = vi.fn(async (_key: string) => undefined);
      await runAsTenant(identity, () =>
        archiveBot(
          {
            prisma,
            sandbox: new FakeSandboxProvider(),
            home: new LocalAgentHomeStore(tmpdir()),
            jobs: { cancel, enqueue: async () => {}, close: async () => {} },
          },
          { id: botId, userId, spaceId, archivedAt: null, name: "Archive race" },
          {
            operationId: "archive-race",
            traceId: "archive-race",
            userId,
            spaceId,
            botId,
            signal: new AbortController().signal,
          },
        ),
      );

      expect(raced).toBe(true);
      for (const [run, status] of [
        [completed, "completed"],
        [failed, "failed"],
        [active, "cancelled"],
      ] as const) {
        expect(await system.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
          status,
          ...(run.id !== active.id ? { completedAt: endedAt } : {}),
        });
        expect(await system.task.findUniqueOrThrow({ where: { id: run.taskId } })).toMatchObject({
          status,
        });
      }
      expect(cancel.mock.calls.map(([key]) => key).sort()).toEqual([
        `routine:${armed!.id}`,
        `run:${active.id}`,
      ]);
      expect(await system.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
        archivedAt: expect.any(Date),
      });
      expect(await system.routine.findUnique({ where: { id: armed!.id } })).toMatchObject({
        active: false,
        resumeOnRestore: true,
        nextRunAt: at,
      });
      const restore = () =>
        runAsTenant(identity, () => restoreBotWithRoutines(db.prisma, { botId, userId, spaceId }));
      await expect(restore()).resolves.toEqual([{ id: armed!.id, nextRunAt: at }]);
      await expect(restore()).resolves.toEqual([{ id: armed!.id, nextRunAt: at }]);
      expect(await system.routine.findUnique({ where: { id: armed!.id } })).toMatchObject({
        active: true,
        resumeOnRestore: false,
        nextRunAt: at,
      });
      expect(await system.routine.findUnique({ where: { id: paused!.id } })).toMatchObject({
        active: false,
        resumeOnRestore: false,
        nextRunAt: null,
      });
    } finally {
      try {
        await system.messagingIdentity.deleteMany({ where: { address } });
        await system.organization.deleteMany({ where: { id: spaceId } });
        await system.user.deleteMany({ where: { id: userId } });
      } finally {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  },
);
