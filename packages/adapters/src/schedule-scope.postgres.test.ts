// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@orkbot/db";
import { asSystem, createDb, runAsTenant } from "@orkbot/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { taskTools } from "./run-tools-tasks.js";
import {
  cancelScheduleFromTool,
  listSchedulesFromTool,
  updateScheduleFromTool,
} from "./schedule-tools.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;
const outsideError = {
  error: "This schedule belongs to another chat. Update or cancel it from its original chat.",
};

describePostgres("group routine discovery and source-chat writes (PostgreSQL)", () => {
  const suffix = randomUUID();
  const userId = `schedule-owner-${suffix}`;
  const otherUserId = `schedule-other-${suffix}`;
  const organizationId = `schedule-org-${suffix}`;
  const spaceId = `schedule-space-${suffix}`;
  const otherSpaceId = `schedule-other-space-${suffix}`;
  const botId = `schedule-bot-${suffix}`;
  const otherBotId = `schedule-other-bot-${suffix}`;
  const otherSpaceBotId = `schedule-other-space-bot-${suffix}`;
  const threadId = `schedule-group-current-${suffix}`;
  const otherThreadId = `schedule-group-other-${suffix}`;
  const dmThreadId = `schedule-dm-${suffix}`;
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const jobs = { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) };
  const events = { append: vi.fn(async () => undefined) };
  const owner = { spaceId, userId };
  const scope = { ...owner, botId };
  const asOwner = <T>(work: () => Promise<T>) => runAsTenant(owner, work);
  const deps = (prisma = db.prisma) =>
    ({ prisma, jobs, events }) as unknown as Parameters<typeof updateScheduleFromTool>[0];
  const update = (routineId: string, patch = {}, prisma = db.prisma) =>
    asOwner(() =>
      updateScheduleFromTool(deps(prisma), {
        ...scope,
        threadId,
        scopeThreadId: threadId,
        routineId,
        name: "Updated",
        schedule: {},
        ...patch,
      }),
    );
  const cancel = (selector: { routineId?: string; name?: string }, prisma = db.prisma) =>
    asOwner(() => cancelScheduleFromTool(deps(prisma), { ...scope, threadId, ...selector }));

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    await system.organization.create({
      data: { id: organizationId, name: "Schedules", slug: organizationId, createdAt: new Date() },
    });
    for (const id of [userId, otherUserId]) {
      await system.user.create({
        data: { id, name: "Fixture", email: `${id}@orkbot.test`, emailVerified: true },
      });
      await system.member.create({
        data: {
          id: `member-${id}`,
          organizationId,
          userId: id,
          role: "member",
          createdAt: new Date(),
        },
      });
    }
    for (const id of [spaceId, otherSpaceId])
      await system.space.create({ data: { id, organizationId, name: "Fixture" } });
    for (const [id, targetSpace] of [
      [botId, spaceId],
      [otherBotId, spaceId],
      [otherSpaceBotId, otherSpaceId],
    ] as const) {
      await system.bot.create({
        data: { id, spaceId: targetSpace, userId, name: "Fixture", color: "#000" },
      });
    }
    await system.thread.create({ data: { id: dmThreadId, spaceId, userId, botId } });
    for (const id of [threadId, otherThreadId]) {
      await system.chatGroup.create({
        data: {
          id: `group-${id}`,
          spaceId,
          userId,
          name: "Fixture",
          members: { create: [{ botId }] },
          thread: { create: { id, spaceId, userId } },
        },
      });
    }
  });
  beforeEach(async () => {
    await system.routine.deleteMany({ where: { spaceId: { in: [spaceId, otherSpaceId] } } });
    jobs.enqueue.mockClear();
    jobs.cancel.mockClear();
    events.append.mockClear();
  });
  afterAll(async () => {
    if (!db) return;
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  function routine(name: string, target: string | null, patch = {}) {
    return system.routine.create({
      data: {
        ...scope,
        name,
        threadId: target,
        prompt: "Fixture instruction",
        crons: ["0 9 * * 1"],
        timezone: "UTC",
        active: false,
        nextRunAt: null,
        ...patch,
      },
    });
  }
  function noEffects() {
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(jobs.cancel).not.toHaveBeenCalled();
    expect(events.append).not.toHaveBeenCalled();
  }

  it("uses real group handlers for bot-wide discovery without leaking other owners, bots or Spaces", async () => {
    const local = await routine("Local", threadId, { createdAt: new Date("2026-01-01") });
    const other = await routine("Other group", otherThreadId, {
      active: true,
      createdAt: new Date("2026-01-02"),
    });
    const dm = await routine("Direct", dmThreadId, { createdAt: new Date("2026-01-03") });
    const legacy = await routine("No target", null, { createdAt: new Date("2026-01-04") });
    await routine("Other owner", threadId, { userId: otherUserId });
    await routine("Other bot", null, { botId: otherBotId });
    await routine("Other Space", null, { botId: otherSpaceBotId, spaceId: otherSpaceId });
    const ctx = {
      deps: deps(),
      run: scope,
      bot: { id: botId },
      thread: { id: threadId, groupId: `group-${threadId}` },
      tools: { offered: [] },
    } as unknown as Parameters<NonNullable<typeof taskTools.schedule_list>>[0];
    const listed = (await asOwner(() =>
      taskTools.schedule_list!(ctx, { args: { threadId: otherThreadId } } as never),
    )) as Awaited<ReturnType<typeof listSchedulesFromTool>>;
    const catalog = (await asOwner(() => taskTools.task_catalog!(ctx, {} as never))) as {
      routines: typeof listed.routines;
    };
    expect(catalog.routines).toEqual(listed.routines);
    expect(listed.routines.map((row) => [row.routineId, row.inThisChat])).toEqual([
      [legacy.id, false],
      [dm.id, false],
      [other.id, false],
      [local.id, true],
    ]);
    expect(listed.routines.map((row) => row.active)).toEqual([false, false, true, false]);
    expect(JSON.stringify(listed)).not.toContain(otherThreadId);
    const privileged = await listSchedulesFromTool(deps(system), { ...scope, threadId });
    expect(privileged).toEqual(listed);
  });

  it("diagnoses known foreign-chat and null-target routines but never writes or publishes", async () => {
    for (const target of [otherThreadId, dmThreadId, null]) {
      const row = await routine(`Outside ${target}`, target);
      expect(await update(row.id)).toEqual(outsideError);
      expect(await cancel({ routineId: row.id })).toEqual(outsideError);
      expect(await cancel({ name: row.name })).toEqual(outsideError);
      expect(await system.routine.findUnique({ where: { id: row.id } })).toMatchObject({
        name: row.name,
        threadId: target,
      });
    }
    noEffects();
  });

  it("keeps foreign owner, bot, Space, missing and archived-parent updates indistinguishable", async () => {
    const foreign = [
      await routine("Private owner", otherThreadId, { userId: otherUserId }),
      await routine("Private bot", null, { botId: otherBotId }),
      await routine("Private Space", null, { botId: otherSpaceBotId, spaceId: otherSpaceId }),
    ];
    for (const row of [...foreign, { id: "missing", name: "Missing" }]) {
      expect(await update(row.id)).toEqual({ error: "Schedule not found." });
      expect(await update(row.id, {}, system)).toEqual({ error: "Schedule not found." });
      expect(await cancel({ routineId: row.id }, system)).toEqual({ error: "Schedule not found." });
      expect(await cancel({ name: row.name }, system)).toEqual({ error: "Schedule not found." });
    }
    const archived = await routine("Archived parent", otherThreadId);
    await system.bot.update({ where: { id: botId }, data: { archivedAt: new Date() } });
    try {
      expect(await update(archived.id, {}, system)).toEqual({ error: "Schedule not found." });
    } finally {
      await system.bot.update({ where: { id: botId }, data: { archivedAt: null } });
    }
    noEffects();
  });

  it("edits a local schedule in place and cancels the exact local name before a newer foreign match", async () => {
    const local = await routine("Daily", threadId, { createdAt: new Date("2026-01-01") });
    const foreign = await routine("Daily", otherThreadId, { createdAt: new Date("2026-01-02") });
    expect(await update(local.id, { name: "Daily", prompt: "Changed instruction" })).toMatchObject({
      ok: true,
      routineId: local.id,
      prompt: "Changed instruction",
    });
    expect(events.append).toHaveBeenCalledOnce();
    expect(await cancel({ name: "Daily" })).toEqual({
      ok: true,
      routineId: local.id,
      name: "Daily",
    });
    expect(await system.routine.findUnique({ where: { id: foreign.id } })).toMatchObject({
      name: "Daily",
      prompt: "Fixture instruction",
    });
    expect(jobs.cancel).toHaveBeenCalledOnce();
    expect(await cancel({ name: "Daily" })).toEqual(outsideError);
  });

  it("does not fall back from a foreign ID to a matching local name", async () => {
    const local = await routine("Daily", threadId);
    const foreign = await routine("Daily", otherThreadId);
    expect(await cancel({ routineId: foreign.id, name: "Daily" })).toEqual(outsideError);
    expect(await system.routine.count({ where: { id: { in: [local.id, foreign.id] } } })).toBe(2);
    noEffects();
  });

  it("keeps DM reads and writes compatible across this owner's bot chats", async () => {
    const row = await routine("Group routine", otherThreadId);
    const listed = await asOwner(() => listSchedulesFromTool(deps(), scope));
    expect(listed.routines).toHaveLength(1);
    expect(listed.routines[0]).not.toHaveProperty("inThisChat");
    expect(
      await asOwner(() =>
        updateScheduleFromTool(deps(), {
          ...scope,
          threadId: dmThreadId,
          routineId: row.id,
          prompt: "DM edit",
          schedule: {},
        }),
      ),
    ).toMatchObject({ ok: true, prompt: "DM edit" });
    expect(
      await asOwner(() => cancelScheduleFromTool(deps(), { ...scope, routineId: row.id })),
    ).toMatchObject({ ok: true });
    expect(await system.routine.findUnique({ where: { id: row.id } })).toBeNull();
  });

  function beforeMutation(method: "updateMany" | "deleteMany", change: () => Promise<unknown>) {
    return new Proxy(db.prisma, {
      get(target, property, receiver) {
        if (property !== "routine") return Reflect.get(target, property, receiver);
        return new Proxy(target.routine, {
          get(delegate, operation, delegateReceiver) {
            if (operation !== method) return Reflect.get(delegate, operation, delegateReceiver);
            return async (args: Parameters<typeof delegate.updateMany>[0]) => {
              await change();
              return Reflect.apply(delegate[method], delegate, [args]);
            };
          },
        });
      },
    });
  }
  it.each(["updateMany", "deleteMany"] as const)(
    "keeps the source-chat predicate at %s after a concurrent move",
    async (method) => {
      const row = await routine("Moved", threadId);
      const prisma = beforeMutation(method, () =>
        system.routine.update({ where: { id: row.id }, data: { threadId: otherThreadId } }),
      );
      const result =
        method === "updateMany"
          ? await update(row.id, {}, prisma)
          : await cancel({ routineId: row.id }, prisma);
      expect(result).toEqual({ error: "Schedule not found." });
      expect(await system.routine.findUnique({ where: { id: row.id } })).toMatchObject({
        name: "Moved",
        threadId: otherThreadId,
      });
      noEffects();
    },
  );

  it("keeps timing compare-and-swap when a tick moves nextRunAt before saving", async () => {
    const nextRunAt = new Date(Date.now() + 86_400_000);
    const row = await routine("Ticked", threadId, { active: true, nextRunAt });
    const moved = new Date(nextRunAt.getTime() + 7 * 86_400_000);
    const prisma = beforeMutation("updateMany", () =>
      system.routine.update({ where: { id: row.id }, data: { nextRunAt: moved } }),
    );
    expect(await update(row.id, { active: false }, prisma)).toEqual({
      error: "The schedule changed while saving. Call schedule_list and try again.",
    });
    expect(await system.routine.findUnique({ where: { id: row.id } })).toMatchObject({
      active: true,
      nextRunAt: moved,
      name: "Ticked",
    });
    noEffects();
  });
});
