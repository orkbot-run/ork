// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { Pool, QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("encrypted roster live activity (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string; botId: string };
  const eventReads: number[] = [];
  const address = `+1555${String(Date.now()).slice(-7)}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!, { encryptContent: true });
    prisma = db.prisma;
    const original = db.pool.query.bind(db.pool);
    db.pool.query = ((...args: unknown[]) => {
      const result = (original as (...inner: unknown[]) => unknown)(...args);
      if (!result || typeof (result as Promise<unknown>).then !== "function") return result;
      return (result as Promise<QueryResult>).then((rows) => {
        const input = args[0];
        const text = typeof input === "string" ? input : ((input as { text?: string })?.text ?? "");
        if (/^\s*select\b/i.test(text) && /\bfrom\s+events\b/i.test(text)) {
          eventReads.push(rows.rowCount ?? 0);
        }
        return rows;
      });
    }) as Pool["query"];

    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    owner = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
  });

  afterAll(async () => {
    if (owner) {
      await asSystem(prisma).messagingIdentity.deleteMany({
        where: { provider: "sendblue", address },
      });
      await asSystem(prisma).organization.deleteMany({ where: { id: owner.spaceId } });
      await asSystem(prisma).user.deleteMany({ where: { id: owner.userId } });
    }
    await close?.();
  });

  it("uses newest progress including clears, ignores other event types, and drops terminal activity", async () => {
    const actor = { ...owner, email: "activity@example.com", isDeploymentOwner: false };
    const repos = createRepos(prisma);
    const bot = await runAsTenant(owner, () =>
      repos.createBot(actor, {
        name: "Activity",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      }),
    );
    const run = await runAsTenant(owner, async () => {
      const task = await prisma.task.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          botId: bot.id,
          threadId: bot.threadId,
          prompt: "test",
          status: "running",
        },
      });
      return prisma.run.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          botId: bot.id,
          threadId: bot.threadId,
          taskId: task.id,
          status: "running",
          trigger: "user",
        },
      });
    });
    // A newer group run for the same bot must never supply its private-chat activity.
    await runAsTenant(owner, async () => {
      const group = await prisma.chatGroup.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          name: "Group",
          members: { create: { botId: bot.id } },
        },
      });
      const thread = await prisma.thread.create({
        data: { spaceId: owner.spaceId, userId: owner.userId, groupId: group.id },
      });
      const task = await prisma.task.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          botId: bot.id,
          threadId: thread.id,
          prompt: "group",
          status: "running",
        },
      });
      const groupRun = await prisma.run.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "running",
          trigger: "user",
        },
      });
      await prisma.event.create({
        data: {
          spaceId: owner.spaceId,
          botId: bot.id,
          threadId: thread.id,
          runId: groupRun.id,
          seq: 0,
          type: "thread.progress",
          payload: { text: "Group-only step", activity: true },
        },
      });
    });
    let seq = 100;
    const append = (payload: Record<string, string | boolean>, type = "thread.progress") =>
      runAsTenant(owner, () =>
        prisma.event.create({
          data: {
            spaceId: owner.spaceId,
            botId: bot.id,
            threadId: bot.threadId,
            runId: run.id,
            seq: seq++,
            type,
            payload,
          },
        }),
      );
    const listed = () =>
      runAsTenant(owner, async () => ({
        full: (await repos.listBots(actor)).find((row) => row.id === bot.id)?.liveActivity,
        navigation: (await repos.listSpaceBotsForSpaces(actor, [owner.spaceId])).find(
          (row) => row.id === bot.id,
        )?.liveActivity,
      }));

    await append({ text: "Old step", activity: true });
    await append({ text: " Reading \n the brief ", activity: true });
    await append({ text: "Unrelated metadata" }, "thread.meta");
    const step = { kind: "step", text: "Reading the brief" };
    const start = eventReads.length;
    expect(await listed()).toEqual({ full: step, navigation: step });
    expect(eventReads.slice(start)).toEqual([1, 1]);
    await append({ text: "", activity: true });
    expect(await listed()).toEqual({ full: undefined, navigation: undefined });
    await append({ text: "The answer", streaming: true });
    expect(await listed()).toEqual({ full: { kind: "writing" }, navigation: { kind: "writing" } });
    await append({ text: "A non-streaming notice" });
    expect(await listed()).toEqual({ full: undefined, navigation: undefined });
    await append({ delta: "Reply", streaming: true });
    await asSystem(prisma).run.update({ where: { id: run.id }, data: { status: "completed" } });
    const afterTerminal = eventReads.length;
    expect(await listed()).toEqual({ full: undefined, navigation: undefined });
    expect(eventReads).toHaveLength(afterTerminal);
  });
});
