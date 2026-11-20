// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { isOneShotRoutineCrons, nextCronDateAcross, nextRoutineRunDateAcross } from "@orkbot/core";
import type { Prisma, PrismaClient } from "./client.js";
import { restoreBotUnderComputerQuota } from "./computers.js";
import { withTransactionRetry } from "./transaction-retry.js";

export const ROUTINE_SCHEDULE_NONCE_PREFIX = "routine-schedule:";
export const routineConversationOpen = {
  OR: [
    { threadId: null },
    { thread: { groupId: null } },
    { thread: { group: { archivedAt: null } } },
  ],
} satisfies Prisma.RoutineWhereInput;

export function pauseRoutinesForArchive(
  tx: Pick<Prisma.TransactionClient, "routine">,
  where: Prisma.RoutineWhereInput,
) {
  return tx.routine.updateMany({
    where: { ...where, active: true },
    // Keep nextRunAt as the pending occurrence, including for one-shots and phased timers.
    data: { active: false, resumeOnRestore: true },
  });
}

const eligibleForRestore = {
  ...routineConversationOpen,
  completedOneShotAt: null,
  bot: { archivedAt: null },
} satisfies Prisma.RoutineWhereInput;

export function restoreBotWithRoutines(
  prisma: PrismaClient,
  input: { botId: string; userId: string; spaceId: string },
) {
  const { botId, ...scope } = input;
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const bot = await tx.bot.findFirstOrThrow({
        where: { ...scope, id: botId },
        select: { archivedAt: true, computerId: true },
      });
      if (bot.archivedAt) {
        if (bot.computerId) {
          await restoreBotUnderComputerQuota(tx, {
            userId: scope.userId,
            botId,
            computerId: bot.computerId,
          });
        } else {
          await tx.bot.update({ where: { id: botId }, data: { archivedAt: null } });
        }
      }
      return resumeArchivedRoutines(tx, { ...scope, botId });
    }),
  );
}

export async function resumeArchivedRoutines(
  tx: Pick<Prisma.TransactionClient, "routine">,
  scope: Prisma.RoutineWhereInput,
  now = new Date(),
) {
  const eligibility = { AND: [scope, eligibleForRestore] };
  const suspended = await tx.routine.findMany({
    where: { ...eligibility, active: false, resumeOnRestore: true },
    select: {
      id: true,
      crons: true,
      timezone: true,
      nextRunAt: true,
      watch: true,
      updatedAt: true,
    },
    orderBy: { id: "asc" },
  });
  for (const routine of suspended) {
    let nextRunAt = routine.nextRunAt;
    if (routine.watch != null) nextRunAt = now;
    else if (isOneShotRoutineCrons(routine.crons)) {
      if (nextRunAt && nextRunAt < now) nextRunAt = now;
    } else if (!nextRunAt || nextRunAt <= now) {
      nextRunAt = nextRunAt
        ? nextRoutineRunDateAcross(routine.crons, nextRunAt, now, routine.timezone)
        : nextCronDateAcross(routine.crons, now, routine.timezone);
    }
    // The guarded write locks the row and leaves a concurrent schedule edit in control.
    await tx.routine.updateMany({
      where: {
        ...eligibility,
        id: routine.id,
        active: false,
        resumeOnRestore: true,
        updatedAt: routine.updatedAt,
      },
      data: { active: true, resumeOnRestore: false, nextRunAt },
    });
  }
  // A repeated restore can repair an earlier restore whose database write committed before enqueue.
  return tx.routine.findMany({
    where: { ...eligibility, active: true, nextRunAt: { not: null } },
    select: { id: true, nextRunAt: true },
  });
}

export async function retireSuccessfulOneShot(
  tx: Pick<Prisma.TransactionClient, "run" | "routine">,
  runId: string,
  now: Date,
) {
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: {
      routineId: true,
      trigger: true,
      retryOfRunId: true,
      clientNonce: true,
      createdAt: true,
    },
  });
  if (!run?.routineId || run.trigger !== "routine") return;
  const prefix = `${ROUTINE_SCHEDULE_NONCE_PREFIX}${run.routineId}:`;
  const origin = run.retryOfRunId
    ? await tx.run.findUnique({
        where: { id: run.retryOfRunId, routineId: run.routineId, trigger: "routine" },
        select: { clientNonce: true, createdAt: true },
      })
    : run;
  if (!origin?.clientNonce?.startsWith(prefix)) return;
  const routine = await tx.routine.findUnique({
    where: { id: run.routineId, active: false, nextRunAt: null, completedOneShotAt: null },
    select: { crons: true, lastRunAt: true },
  });
  if (!routine?.lastRunAt || !isOneShotRoutineCrons(routine.crons)) return;
  await tx.routine.updateMany({
    where: {
      id: run.routineId,
      active: false,
      nextRunAt: null,
      lastRunAt: routine.lastRunAt,
      completedOneShotAt: null,
      crons: { equals: routine.crons },
      // A newer scheduled occurrence means this routine was edited and fired again.
      runs: { none: { clientNonce: { startsWith: prefix }, createdAt: { gt: origin.createdAt } } },
    },
    data: { completedOneShotAt: now, accountFailures: 0 },
  });
}
