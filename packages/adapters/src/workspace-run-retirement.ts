// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { ACTIVE_RUN_STATUSES } from "@orkbot/core";
import type { Run, RunLease } from "@orkbot/db";
import {
  appendEventInTransaction,
  clearEndedRunState,
  expireComputerExecutionLeases,
  runAsSystem,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  transientRunEventsWhere,
  withTransactionRetry,
} from "@orkbot/db";
import type { ExecutorDeps } from "./executor-deps.js";

type Admission = Pick<
  Run,
  | "id"
  | "spaceId"
  | "userId"
  | "threadId"
  | "botId"
  | "taskId"
  | "centralWorkspaceId"
  | "workspaceMembershipVersion"
  | "personalDeviceId"
>;

/** After an authoritative denial, retire only this worker's exact captured attempt. */
export async function retireWorkspaceRun(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  run: Admission,
  lease: RunLease,
): Promise<boolean> {
  return runAsSystem("retire a fenced run whose workspace admission ended", async () => {
    const committed = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        // Match the existing finalizer's thread-then-run lock order.
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR UPDATE`;
        const now = new Date();
        const cancelled = await tx.run.updateMany({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            userId: run.userId,
            threadId: run.threadId,
            botId: run.botId,
            taskId: run.taskId,
            centralWorkspaceId: run.centralWorkspaceId,
            workspaceMembershipVersion: run.workspaceMembershipVersion,
            personalDeviceId: run.personalDeviceId,
            status: "running",
            leaseOwner: lease.owner,
            leaseFence: lease.fence,
          },
          data: {
            status: "cancelled",
            error: "Workspace access expired or was revoked.",
            completedAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        if (cancelled.count !== 1) return null;
        await clearEndedRunState(tx, [run.id]);
        await tx.attempt.updateMany({
          where: { runId: run.id, fence: lease.fence, status: "running" },
          data: { status: "cancelled", finishedAt: now },
        });
        await tx.task.updateMany({
          where: {
            id: run.taskId,
            spaceId: run.spaceId,
            userId: run.userId,
            runs: {
              none: { id: { not: run.id }, status: { in: [...ACTIVE_RUN_STATUSES] } },
            },
          },
          data: { status: "cancelled" },
        });
        const event = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          runId: run.id,
          type: "run.cancelled",
          payload: {},
        });
        await tx.event.deleteMany({ where: { runId: run.id, ...transientRunEventsWhere() } });
        await expireComputerExecutionLeases(tx, { runId: run.id });
        await tx.computer.updateMany({
          where: {
            controlRunId: run.id,
            OR: [{ controlHolder: { not: "user" } }, { controlLeaseId: null }],
          },
          data: { controlRunId: null },
        });
        await tx.computer.updateMany({
          where: { executionRunId: run.id },
          data: { executionRunId: null, executionBotId: null, executionLeaseExpiresAt: null },
        });
        return event;
      }, THREAD_LOCK_TRANSACTION_OPTIONS),
    );
    if (!committed) return false;
    await deps.events.notify(committed.threadId, committed.seq).catch(() => undefined);
    return true;
  });
}
