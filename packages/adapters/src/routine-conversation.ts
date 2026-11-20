// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Prisma } from "@orkbot/db";

export const ROUTINE_TIMER_NONCE_PREFIX = "routine-timer:";
const SCHEDULE_PREFIX = "routine-schedule:";
const SCHEDULE_PREFIXES = [ROUTINE_TIMER_NONCE_PREFIX, SCHEDULE_PREFIX];

export function scheduledRoutineNonce(routineId: string, scheduledFor: string): string {
  return `${SCHEDULE_PREFIX}${routineId}:${scheduledFor}`;
}

export function isScheduledRoutineRun(run: {
  trigger: string;
  clientNonce: string | null | undefined;
}): boolean {
  return (
    run.trigger === "routine" &&
    SCHEDULE_PREFIXES.some((prefix) => run.clientNonce?.startsWith(prefix))
  );
}

type Conversation = { threadId: string; botId: string };

/** Claimers serialize by bot and thread without competing with transcript writes or reads. */
export async function lockRunConversation(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  { threadId, botId }: Conversation,
): Promise<void> {
  const key = JSON.stringify(["run-conversation", threadId, botId]);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
}

function scheduledRoutineWhere(): Prisma.RunWhereInput {
  return {
    trigger: "routine",
    OR: SCHEDULE_PREFIXES.map((startsWith) => ({ clientNonce: { startsWith } })),
  };
}

export function dueScheduledRoutine(now: Date): Prisma.RunWhereInput {
  return {
    status: "queued",
    AND: [scheduledRoutineWhere(), { OR: [{ wakeAt: null }, { wakeAt: { lte: now } }] }],
  };
}

export function liveScheduledRoutine(botId: string, now: Date): Prisma.RunWhereInput {
  return {
    ...scheduledRoutineWhere(),
    botId,
    status: { in: ["leased", "running"] },
    leaseExpiresAt: { gt: now },
  };
}

/** Call under the admission lock before claiming a queued scheduled routine. */
export async function mayClaimScheduledRoutine(
  tx: Pick<Prisma.TransactionClient, "run">,
  run: Conversation & { id: string; createdAt: Date },
  now: Date,
): Promise<boolean> {
  const blocker = await tx.run.findFirst({
    where: {
      threadId: run.threadId,
      botId: run.botId,
      id: { not: run.id },
      OR: [
        { status: { in: ["leased", "running"] }, leaseExpiresAt: { gt: now } },
        { status: { in: ["waiting_input", "waiting_takeover"] } },
        {
          AND: [
            dueScheduledRoutine(now),
            {
              OR: [
                { createdAt: { lt: run.createdAt } },
                { createdAt: run.createdAt, id: { lt: run.id } },
              ],
            },
          ],
        },
      ],
    },
    select: { id: true },
  });
  return blocker === null;
}
