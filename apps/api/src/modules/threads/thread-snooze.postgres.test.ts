// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Actor } from "@orkbot/contracts";
import {
  asSystem,
  countUnreadInboxChats,
  createDb,
  createGroupRepos,
  createRepos,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@orkbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("thread snooze (PostgreSQL)", () => {
  it.each(["UTC", "Europe/Warsaw", "America/New_York"])(
    "keeps snoozes private and timed correctly with database timezone %s",
    async (timezone) => {
      const databaseUrl = new URL(process.env.DATABASE_URL!);
      databaseUrl.searchParams.set("options", `-c timezone=${timezone}`);
      const { prisma, pool } = createDb(databaseUrl.href);
      const system = asSystem(prisma);
      const identity = await runAsSystem("test fixture", () =>
        provisionMessagingIdentity(
          prisma,
          {
            provider: "sendblue",
            address: `snooze-fixture-${crypto.randomUUID()}`,
          },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        ),
      );
      const actor: Actor = { ...identity, email: "snooze@example.test", isDeploymentOwner: false };
      const otherUser = `snooze-other-${crypto.randomUUID()}`;
      try {
        await system.user.create({
          data: {
            id: otherUser,
            name: "Other",
            email: `${otherUser}@example.test`,
            emailVerified: false,
          },
        });
        const deps = {
          prisma,
          env: { webOrigin: "http://127.0.0.1", sandboxProvider: "fake", agentRuntime: "scripted" },
        } as RouterDeps;
        const handler = new RPCHandler(createRouter(deps));
        const call = async (name: string, body: unknown, requestActor: Actor = actor) => {
          const { response } = await runAsTenant(requestActor, () =>
            handler.handle(
              new Request(`http://127.0.0.1/rpc/${name}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ json: body }),
              }),
              { prefix: "/rpc", context: { actor: requestActor } },
            ),
          );
          if (!response) throw new Error("Missing RPC response");
          return response;
        };
        const bot = await runAsTenant(actor, () =>
          createRepos(prisma).createBot(actor, {
            name: "Snooze bot",
            description: "",
            instructions: "",
            notifyOnFinish: true,
          }),
        );
        await system.thread.update({ where: { id: bot.threadId }, data: { unread: true } });
        const before = await runAsTenant(actor, () => countUnreadInboxChats(prisma, actor));
        const future = new Date(Date.now() + 3_600_000).toISOString();
        expect((await call("threads/snooze", { botId: bot.id, until: future })).status).toBe(200);
        const stored = await runAsSystem(
          "check stored snooze instant",
          () =>
            prisma.$queryRaw<Array<{ epoch: number; active: boolean }>>`
          SELECT extract(epoch FROM "until")::float8 AS epoch, "until" > clock_timestamp() AS active
          FROM thread_snoozes WHERE "threadId" = ${bot.threadId} AND "userId" = ${actor.userId}`,
        );
        expect(stored[0]?.epoch).toBeCloseTo(Date.parse(future) / 1000, 3);
        expect(stored[0]?.active).toBe(true);
        expect(
          (await runAsTenant(actor, () => createRepos(prisma).listBots(actor))).find(
            (row) => row.id === bot.id,
          )?.snoozedUntil,
        ).toBe(future);
        expect(await runAsTenant(actor, () => countUnreadInboxChats(prisma, actor))).toBe(
          before - 1,
        );
        const foreign = { ...actor, userId: otherUser };
        expect((await call("threads/unsnooze", { botId: bot.id }, foreign)).status).not.toBe(200);
        expect(
          await runAsTenant(foreign, () =>
            prisma.threadSnooze.findMany({ where: { threadId: bot.threadId } }),
          ),
        ).toEqual([]);
        await system.threadSnooze.update({
          where: { threadId_userId: { threadId: bot.threadId, userId: actor.userId } },
          data: { until: new Date(Date.now() - 1000) },
        });
        const expired = await system.threadSnooze.findUniqueOrThrow({
          where: { threadId_userId: { threadId: bot.threadId, userId: actor.userId } },
        });
        expect(await runAsTenant(actor, () => countUnreadInboxChats(prisma, actor))).toBe(before);
        expect((await call("threads/markRead", { botId: bot.id })).status).toBe(200);
        expect(
          await system.threadSnooze.findUnique({
            where: { threadId_userId: { threadId: bot.threadId, userId: actor.userId } },
          }),
        ).toMatchObject({ until: null, suppressCompletedThrough: expect.any(Date) });
        const woken = await system.threadSnooze.findUniqueOrThrow({
          where: { threadId_userId: { threadId: bot.threadId, userId: actor.userId } },
        });
        expect(woken.suppressCompletedThrough.getTime()).toBeGreaterThanOrEqual(
          expired.until!.getTime(),
        );
        const responses = await Promise.all([
          call("threads/snooze", { botId: bot.id, until: future }),
          call("threads/snooze", { botId: bot.id, until: future }),
        ]);
        expect(responses.map((response) => response.status)).toEqual([200, 200]);
        const resnoozed = await system.threadSnooze.findUniqueOrThrow({
          where: { threadId_userId: { threadId: bot.threadId, userId: actor.userId } },
        });
        expect(resnoozed.suppressCompletedThrough.getTime()).toBeGreaterThanOrEqual(
          woken.suppressCompletedThrough.getTime(),
        );
        expect((await call("threads/unsnooze", { botId: bot.id })).status).toBe(200);
        const early = await system.threadSnooze.findUniqueOrThrow({
          where: { threadId_userId: { threadId: bot.threadId, userId: actor.userId } },
        });
        expect(early.until).toBeNull();
        expect(early.suppressCompletedThrough.getTime()).toBeGreaterThanOrEqual(
          resnoozed.suppressCompletedThrough.getTime(),
        );
        expect(early.suppressCompletedThrough.getTime()).toBeLessThan(new Date(future).getTime());
        const racing = await Promise.all([
          call("threads/snooze", { botId: bot.id, until: future }),
          call("threads/unsnooze", { botId: bot.id }),
        ]);
        expect(racing.map((response) => response.status)).toEqual([200, 200]);
        const afterRace = await system.threadSnooze.findUniqueOrThrow({
          where: { threadId_userId: { threadId: bot.threadId, userId: actor.userId } },
        });
        expect(afterRace.suppressCompletedThrough.getTime()).toBeGreaterThanOrEqual(
          early.suppressCompletedThrough.getTime(),
        );
        expect([null, future]).toContain(afterRace.until?.toISOString() ?? null);
        expect(
          (
            await call("threads/snooze", {
              botId: bot.id,
              until: new Date(Date.now() - 1000).toISOString(),
            })
          ).status,
        ).toBe(400);
        const peer = await runAsTenant(actor, () =>
          createRepos(prisma).createBot(actor, {
            name: "Snooze peer",
            description: "",
            instructions: "",
            notifyOnFinish: true,
          }),
        );
        const group = await runAsTenant(actor, () =>
          createGroupRepos(prisma).createGroup(actor, {
            name: "Snooze group",
            botIds: [bot.id, peer.id],
          }),
        );
        expect((await call("threads/snooze", { groupId: group.id, until: future })).status).toBe(
          200,
        );
        expect(
          (await runAsTenant(actor, () => createGroupRepos(prisma).listGroups(actor))).find(
            (row) => row.id === group.id,
          )?.snoozedUntil,
        ).toBe(future);
        expect((await call("threads/unsnooze", { groupId: group.id })).status).toBe(200);
        expect(
          await system.threadSnooze.findUnique({
            where: { threadId_userId: { threadId: group.threadId, userId: actor.userId } },
          }),
        ).toMatchObject({ until: null, suppressCompletedThrough: expect.any(Date) });
      } finally {
        await system.user.deleteMany({ where: { id: { in: [identity.userId, otherUser] } } });
        await prisma.$disconnect();
        await pool.end();
      }
    },
  );
});
