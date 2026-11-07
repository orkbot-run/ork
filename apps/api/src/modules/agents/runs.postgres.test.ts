// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { Actor } from "@orkbot/contracts";
import { activityChatKey } from "@orkbot/core";
import type { PrismaClient } from "@orkbot/db";
import {
  asSystem,
  createDb,
  createSpaceForMember,
  createThreadMessage,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@orkbot/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listSpaceRuns } from "./runs.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

describe.skipIf(!enabled)("recent activity by chat (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let actor: Actor;
  let initial: { id: string; threadId: string };
  const identities: Array<{ userId: string; spaceId: string }> = [];

  beforeAll(() => {
    const db = createDb(process.env.DATABASE_URL!, { encryptContent: true });
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
  });
  beforeEach(async () => {
    const identity = await runAsSystem("recent activity fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "test", address: `recent-activity-${randomUUID()}` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    identities.push(identity);
    actor = { spaceId: identity.spaceId, userId: identity.userId } as Actor;
    initial = { id: identity.botId, threadId: identity.threadId };
  });
  afterEach(async () => {
    for (const identity of identities.splice(0)) {
      await system.messagingIdentity.deleteMany({ where: { userId: identity.userId } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
  });
  afterAll(async () => close?.());

  async function bot(name: string, spaceId = actor.spaceId) {
    const row = await system.bot.create({
      data: {
        spaceId,
        userId: actor.userId,
        name,
        color: "primary",
        thread: { create: { spaceId, userId: actor.userId } },
      },
      include: { thread: true },
    });
    return { id: row.id, threadId: row.thread!.id };
  }
  async function group(members: string[], id?: string) {
    const row = await system.chatGroup.create({
      data: {
        ...(id ? { id } : {}),
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Group",
        members: { create: members.map((botId) => ({ botId })) },
        thread: { create: { spaceId: actor.spaceId, userId: actor.userId } },
      },
      include: { thread: true },
    });
    return { id: row.id, threadId: row.thread!.id };
  }
  async function run(
    target: { id: string; threadId: string },
    seconds: number,
    options: {
      id?: string;
      status?: string;
      trigger?: string;
      spaceId?: string;
      userId?: string;
      completedAt?: Date | null;
      updatedAt?: Date;
    } = {},
  ) {
    const common = {
      spaceId: options.spaceId ?? actor.spaceId,
      userId: options.userId ?? actor.userId,
      botId: target.id,
      threadId: target.threadId,
    };
    const task = await system.task.create({
      data: { ...common, prompt: "Activity fixture plaintext", status: "completed" },
    });
    return system.run.create({
      data: {
        ...common,
        taskId: task.id,
        id: options.id,
        status: options.status ?? "completed",
        trigger: options.trigger ?? "user_message",
        createdAt: at(seconds),
        completedAt: options.completedAt === undefined ? at(seconds) : options.completedAt,
        updatedAt: options.updatedAt ?? at(seconds),
      },
    });
  }
  const recent = () => runAsTenant(actor, () => listSpaceRuns(prisma, actor, "recent"));

  it.each(["bot", "group"] as const)(
    "selects each chat before the limit when one %s has more than twenty newer runs",
    async (kind) => {
      const peer = await bot("Peer");
      const busyGroup = kind === "group" ? await group([initial.id, peer.id]) : null;
      let latest = "";
      for (let index = 0; index < 40; index++) {
        const member = index % 2 === 0 ? initial : peer;
        latest = (
          await run(busyGroup ? { ...member, threadId: busyGroup.threadId } : initial, 500 + index)
        ).id;
      }
      const quiet = [];
      for (let index = 0; index < 5; index++)
        quiet.push((await run(await bot(`Quiet ${index}`), 100 + index)).id);
      if (busyGroup) {
        quiet.unshift((await run(initial, 50)).id);
        const another = await group([initial.id, peer.id]);
        quiet.push((await run({ ...peer, threadId: another.threadId }, 105)).id);
      }
      const rows = await recent();
      expect(rows.map((row) => row.runId)).toEqual([latest, ...quiet.reverse()]);
      expect(new Set(rows.map(activityChatKey)).size).toBe(rows.length);
      if (busyGroup) expect(rows[0]).toMatchObject({ botId: peer.id, groupId: busyGroup.id });
    },
  );

  it("limits distinct chats to twenty, retaining bot and group ID namespaces", async () => {
    const sameId = await group([initial.id], initial.id);
    const direct = await run(initial, 100);
    const shared = await run({ ...initial, threadId: sameId.threadId }, 101);
    const expected = [direct.id, shared.id];
    for (let index = 0; index < 23; index++)
      expected.push((await run(await bot(`Chat ${index}`), 70 + index)).id);
    const rows = await recent();
    expect(rows).toHaveLength(20);
    expect(rows.map((row) => row.runId)).toEqual([
      shared.id,
      direct.id,
      ...expected.slice(2).reverse().slice(0, 18),
    ]);
    expect(new Set(rows.map(activityChatKey)).size).toBe(20);
    expect(rows.slice(0, 2).map(activityChatKey)).toEqual([
      `group:${initial.id}`,
      `bot:${initial.id}`,
    ]);
  });

  it("uses completion, update and ID order inside each chat and across the final selection", async () => {
    const peer = await bot("Peer");
    await run(initial, 100, { id: "activity-a", updatedAt: at(110) });
    await run(initial, 100, { id: "activity-z", updatedAt: at(110) });
    await run(initial, 100, { id: "activity-older-update", updatedAt: at(109) });
    await run(peer, 100, { id: "activity-y", updatedAt: at(110) });
    await run(peer, 99, { id: "activity-new-update", updatedAt: at(200) });
    expect((await recent()).map((row) => row.runId)).toEqual(["activity-z", "activity-y"]);
  });

  it("filters owner, Space, archived bots and background work before selecting winners", async () => {
    const keep = await run(initial, 100);
    await run(initial, 200, { trigger: "tickets" });
    await run(initial, 201, { status: "running" });
    await run(initial, 202, { userId: "foreign-activity-user" });
    const archived = await bot("Archived");
    await run(archived, 300);
    await system.bot.update({ where: { id: archived.id }, data: { archivedAt: at(400) } });
    const otherSpace = await runAsSystem("recent activity fixture", () =>
      createSpaceForMember(prisma, {
        currentSpaceId: actor.spaceId,
        userId: actor.userId,
        name: "Other",
      }),
    );
    await run(await bot("Elsewhere", otherSpace.id), 500, { spaceId: otherSpace.id });
    expect((await recent()).map((row) => row.runId)).toEqual([keep.id]);
    // Explicit actor filters remain necessary even through a system-scoped database caller.
    expect((await listSpaceRuns(system, actor, "recent")).map((row) => row.runId)).toEqual([
      keep.id,
    ]);
  });

  it("hydrates encrypted previews through Prisma and keeps terminal statuses and legacy timestamp fallback", async () => {
    const statuses = ["completed", "failed", "cancelled"];
    const expected = [];
    for (const [index, status] of statuses.entries())
      expected.push(await run(await bot(status), 100 + index, { status }));
    const legacy = await run(initial, 99, { completedAt: null });
    const rows = await recent();
    expect(new Set(rows.map((row) => row.runId))).toEqual(
      new Set([...expected.map((row) => row.id), legacy.id]),
    );
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(statuses));
    expect(rows.every((row) => row.promptSnippet === "Activity fixture plaintext")).toBe(true);
    const source = await runAsTenant(actor, () =>
      createThreadMessage(prisma, {
        threadId: initial.threadId,
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: initial.id,
            fromBotName: "Peer",
            text: "Encrypted source text",
            intent: "request",
          },
        ],
      }),
    );
    await system.run.update({
      where: { id: legacy.id },
      data: { trigger: "bot_message", sourceMessageId: source.id },
    });
    expect((await recent()).find((row) => row.runId === legacy.id)).toMatchObject({
      promptSnippet: "Peer asked: Encrypted source text",
      agentMessage: { fromBotName: "Peer", kind: "request", text: "Encrypted source text" },
    });
    expect(rows.find((row) => row.runId === legacy.id)?.updatedAt).toBe(at(99).toISOString());
    const [stored] = await system.$queryRaw<Array<{ blocks: string }>>`
      SELECT blocks::text FROM messages WHERE id = ${source.id}`;
    expect(stored!.blocks).not.toContain("Encrypted source text");
  });

  it("retains all active siblings and leaves finished rows out of the active path", async () => {
    const first = await run(initial, 100, { status: "running", completedAt: null });
    const second = await run(initial, 101, { status: "waiting_input", completedAt: null });
    await run(initial, 102);
    const rows = await runAsTenant(actor, () => listSpaceRuns(prisma, actor, "active"));
    expect(rows.map((row) => row.runId)).toEqual([second.id, first.id]);
  });
});
