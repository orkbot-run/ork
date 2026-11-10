// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved; bounded recent chat selection follows LICENSE.md.

import type { Actor, RunActivityRow } from "@orkbot/contracts";
import { MessageBlock } from "@orkbot/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_RUN_TRIGGERS,
  botMessageContext,
  displayName,
  truncatePlainText,
} from "@orkbot/core";
import type { PrismaClient } from "@orkbot/db";
import { Prisma } from "@orkbot/db";

const RECENT_LIMIT = 20;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

function promptSnippet(prompt: string, max = 120): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${truncatePlainText(oneLine, max - 1)}…`;
}

export function activityPreview(
  input: { trigger: string; prompt: string; sourceBlocks?: unknown },
  max = 120,
): Pick<RunActivityRow, "promptSnippet" | "agentMessage"> {
  if (input.trigger !== "bot_message")
    return { promptSnippet: promptSnippet(input.prompt, max), agentMessage: null };
  const parsed = MessageBlock.array().safeParse(input.sourceBlocks);
  const message = parsed.success ? botMessageContext(parsed.data) : undefined;
  if (!message) {
    return {
      promptSnippet: "Message from another agent",
      agentMessage: { kind: "unknown" },
    };
  }
  const name = displayName(message.fromBotName, "Another agent");
  const kind =
    message.intent === "result" || message.intent === "status" || message.intent === "fyi"
      ? "update"
      : "request";
  const label = kind === "update" ? `Update from ${name}` : `${name} asked`;
  return {
    promptSnippet: promptSnippet(message.text.trim() ? `${label}: ${message.text}` : label, max),
    agentMessage: {
      fromBotName: displayName(message.fromBotName, ""),
      kind,
      text: promptSnippet(message.text, max),
    },
  };
}

export function activityNotificationsEnabled(
  groupId: string | null,
  notifyOnFinish: boolean,
): boolean {
  return groupId !== null || notifyOnFinish;
}

export function snoozedCompletion(
  snooze: { until: Date | null; suppressCompletedThrough: Date } | undefined,
  status: string,
  completedAt: Date | null,
  now: number,
): boolean {
  if (!snooze) return false;
  const until = snooze.until?.getTime();
  if (until !== undefined && until > now) return true;
  if (status !== "completed") return false;
  // Legacy completed runs may have no timestamp; do not resurrect an unknown old notice.
  if (!completedAt) return true;
  const cutoff = Math.max(snooze.suppressCompletedThrough.getTime(), Math.min(until ?? 0, now));
  return completedAt.getTime() <= cutoff;
}

export async function listSpaceRuns(
  prisma: PrismaClient,
  actor: Actor,
  filter: "active" | "recent",
): Promise<RunActivityRow[]> {
  // Match activityChatKey: a group is one chat across all its member bots.
  // Select only IDs here so previews still pass through Prisma's content decryption.
  const recent =
    filter === "recent"
      ? await prisma.$queryRaw<Array<{ id: string }>>`
          WITH ranked AS (
            SELECT r.id, r."completedAt", r."updatedAt",
              row_number() OVER (
                PARTITION BY CASE WHEN t."groupId" IS NOT NULL
                  THEN 'group:' || t."groupId" ELSE 'bot:' || r."botId" END
                ORDER BY r."completedAt" DESC, r."updatedAt" DESC, r.id DESC
              ) AS position
            FROM runs r
            JOIN bots b ON b.id = r."botId"
            JOIN threads t ON t.id = r."threadId"
            WHERE r."spaceId" = ${actor.spaceId} AND r."userId" = ${actor.userId}
              AND b."archivedAt" IS NULL
              AND r.trigger NOT IN (${Prisma.join([...BACKGROUND_RUN_TRIGGERS])})
              AND r.status IN (${Prisma.join([...TERMINAL_STATUSES])})
          )
          SELECT id FROM ranked WHERE position = 1
          ORDER BY "completedAt" DESC, "updatedAt" DESC, id DESC
          LIMIT ${RECENT_LIMIT}`
      : undefined;
  if (recent?.length === 0) return [];
  const rows = await prisma.run.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      ...(recent ? { id: { in: recent.map((row) => row.id) } } : {}),
      bot: { archivedAt: null },
      // Background ticket work belongs on the board, not in the activity list.
      trigger: { notIn: [...BACKGROUND_RUN_TRIGGERS] },
      ...(filter === "active"
        ? { status: { in: [...ACTIVE_RUN_STATUSES] } }
        : { status: { in: [...TERMINAL_STATUSES] } }),
    },
    include: {
      bot: { select: { name: true, archivedAt: true, notifyOnFinish: true } },
      task: { select: { prompt: true } },
      sourceMessage: { select: { blocks: true } },
      thread: {
        select: {
          groupId: true,
          group: { select: { name: true } },
        },
      },
    },
    orderBy:
      filter === "active"
        ? [{ updatedAt: "desc" }, { id: "desc" }]
        : [{ completedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
  });

  const snoozes = rows.length
    ? await prisma.threadSnooze.findMany({
        where: { userId: actor.userId, threadId: { in: rows.map((row) => row.threadId) } },
        select: { threadId: true, until: true, suppressCompletedThrough: true },
      })
    : [];
  const snoozedThreads = new Map(snoozes.map((row) => [row.threadId, row]));
  const now = Date.now();
  return rows.map((row) => ({
    runId: row.id,
    botId: row.botId,
    botName: row.bot.name,
    groupId: row.thread.groupId,
    groupName: row.thread.group ? row.thread.group.name : null,
    threadId: row.threadId,
    status: row.status as RunActivityRow["status"],
    trigger: row.trigger as RunActivityRow["trigger"],
    notificationsEnabled: activityNotificationsEnabled(row.thread.groupId, row.bot.notifyOnFinish),
    snoozed: snoozedCompletion(snoozedThreads.get(row.threadId), row.status, row.completedAt, now),
    ...activityPreview({
      trigger: row.trigger,
      prompt: row.task.prompt,
      sourceBlocks: row.sourceMessage?.blocks,
    }),
    updatedAt: (filter === "recent" && row.completedAt
      ? row.completedAt
      : row.updatedAt
    ).toISOString(),
  }));
}
