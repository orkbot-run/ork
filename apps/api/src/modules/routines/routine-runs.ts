// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 history is preserved; durable checklist projections are Ork additions.

import type { Actor, RoutineHistory, RoutineRun, RoutineRunCursor } from "@orkbot/contracts";
import {
  LEGACY_ROUTINE_CHECKLIST_EVENT_TYPE,
  ROUTINE_CHECKLIST_EVENT_TYPE,
  ROUTINE_HISTORY_PAGE_SIZE,
  routineChecklistFromEvent,
} from "@orkbot/contracts";
import { runFailureError } from "@orkbot/core";
import type { PrismaClient } from "@orkbot/db";
import { contentEncryptionOf, Prisma } from "@orkbot/db";
import { ORPCError } from "@orpc/server";

export async function listRoutineRuns(
  prisma: PrismaClient,
  actor: Actor,
  routineId: string,
  before?: RoutineRunCursor,
  limit = ROUTINE_HISTORY_PAGE_SIZE,
): Promise<RoutineHistory> {
  const routine = await prisma.routine.findFirst({
    where: {
      id: routineId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
    },
    select: { botId: true },
  });
  if (!routine) throw new ORPCError("NOT_FOUND");

  const rows = await prisma.run.findMany({
    where: {
      routineId,
      botId: routine.botId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      ...(before
        ? {
            OR: [
              { createdAt: { lt: new Date(before.createdAt) } },
              { createdAt: new Date(before.createdAt), id: { lt: before.id } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      botId: true,
      threadId: true,
      thread: { select: { groupId: true } },
      status: true,
      error: true,
      lateSince: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const runs = rows.slice(0, limit);
  const last = runs.at(-1);
  const nextCursor =
    rows.length > limit && last ? { id: last.id, createdAt: last.createdAt.toISOString() } : null;
  // Routine runs can finish silently. A chat link opens the first message a run posted.
  const runIds = runs.map((run) => run.id);
  const [messages, checklistEvents] = runIds.length
    ? await Promise.all([
        prisma.$queryRaw<Array<{ id: string; runId: string; threadId: string }>>(Prisma.sql`
        SELECT DISTINCT ON (m."runId") m.id, m."runId", m."threadId"
        FROM messages m
        INNER JOIN runs r ON r.id = m."runId" AND r."threadId" = m."threadId"
        INNER JOIN threads t ON t.id = m."threadId"
        WHERE r.id IN (${Prisma.join(runIds)})
          AND r."spaceId" = ${actor.spaceId} AND r."userId" = ${actor.userId}
          AND t."spaceId" = ${actor.spaceId} AND t."userId" = ${actor.userId}
          AND m.role = 'bot'
        ORDER BY m."runId", m.seq
      `),
        // Select only one snapshot per run in PostgreSQL, even for long checklists.
        prisma.$queryRaw<
          Array<{ id: string; spaceId: string; runId: string; threadId: string; payload: unknown }>
        >(Prisma.sql`
        SELECT r.id AS "runId", r."threadId", r."spaceId", snapshot.id, snapshot.payload
        FROM runs r
        JOIN LATERAL (
          SELECT e.id, e.payload FROM events e
          WHERE e."runId" = r.id AND e."threadId" = r."threadId" AND e."spaceId" = r."spaceId"
            AND e.type IN (${LEGACY_ROUTINE_CHECKLIST_EVENT_TYPE}, ${ROUTINE_CHECKLIST_EVENT_TYPE})
          ORDER BY e.seq DESC LIMIT 1
        ) snapshot ON true
        WHERE r.id IN (${Prisma.join(runIds)})
          AND r."spaceId" = ${actor.spaceId} AND r."userId" = ${actor.userId}
      `),
      ])
    : [[], []];
  await contentEncryptionOf(prisma)?.openRows("Event", checklistEvents);
  const replyByRun = new Map(messages.map((message) => [message.runId, message.id]));
  const checklistByRun = new Map(
    checklistEvents.flatMap((event) => {
      const run = runs.find((run) => run.id === event.runId && run.threadId === event.threadId);
      const checklist = routineChecklistFromEvent(event.payload);
      return run && checklist ? [[run.id, checklist] as const] : [];
    }),
  );
  return {
    nextCursor,
    runs: runs.map((run) => ({
      id: run.id,
      botId: run.botId,
      groupId: run.thread.groupId,
      status: run.status as RoutineRun["status"],
      error: runFailureError({ type: `run.${run.status}`, payload: { error: run.error } }),
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      lateSince: run.lateSince?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      messageId: replyByRun.get(run.id) ?? null,
      ...(checklistByRun.has(run.id) ? { checklist: checklistByRun.get(run.id)! } : {}),
    })),
  };
}
