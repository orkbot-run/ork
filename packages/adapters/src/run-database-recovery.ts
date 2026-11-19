// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { runContinueJob } from "@orkbot/adapter-kit";
import { databaseOperationFailed, isDatabaseUnavailable, retryDatabaseOperation } from "@orkbot/db";
import type { ExecutorDeps } from "./executor-deps.js";
import type { RunContext } from "./run-context.js";

export async function recoverRunSetupFromDatabaseOutage(
  deps: ExecutorDeps,
  input: { runId: string; workerId: string; fence?: number; deadline: number },
  error: unknown,
): Promise<boolean> {
  if (!isDatabaseUnavailable(error)) return false;
  databaseOperationFailed(error);
  try {
    await retryDatabaseOperation(
      async () => {
        if (input.fence !== undefined) {
          await deps.prisma.run.updateMany({
            where: {
              id: input.runId,
              status: { in: ["leased", "running"] },
              leaseOwner: input.workerId,
              leaseFence: input.fence,
              leaseExpiresAt: { gt: new Date() },
            },
            data: {
              status: "queued",
              error: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              wakeAt: new Date(Date.now() + 3_000),
            },
          });
          await deps.prisma.attempt.updateMany({
            where: {
              runId: input.runId,
              fence: input.fence,
              status: { in: ["running", "interrupted"] },
            },
            data: { status: "setup_failed", error: null, finishedAt: new Date() },
          });
        } else {
          // No claim was made; only wait for a DB read before publishing a new wake-up.
          await deps.prisma.run.findUnique({ where: { id: input.runId }, select: { id: true } });
        }
        await deps.jobs.enqueue({
          ...runContinueJob(input.runId),
          availableAt: new Date(Date.now() + 3_000),
        });
      },
      { deadline: () => input.deadline, signal: deps.shutdownSignal },
    );
  } catch (retryError) {
    if (!isDatabaseUnavailable(retryError) && !deps.shutdownSignal?.aborted) throw retryError;
  }
  return true;
}

/** Retry only fenced/idempotent persistence, within the last confirmed leases. */
export function retryRunDatabaseOperation<T>(
  ctx: RunContext,
  operation: () => Promise<T>,
): Promise<T> {
  const fallbackDeadline = Date.now() + 4 * 60_000;
  return retryDatabaseOperation(operation, {
    deadline: () => ctx.state.lease.databaseDeadline ?? fallbackDeadline,
    signal: ctx.deps.shutdownSignal,
  });
}

/** Stop this attempt without recording an outage as a failed run or failed setup. */
export async function recoverRunFromDatabaseOutage(
  ctx: RunContext,
  error: unknown,
): Promise<boolean> {
  if (!isDatabaseUnavailable(error)) return false;
  databaseOperationFailed(error);
  const { lease } = ctx.state;
  if (!lease.valid || ctx.deps.shutdownSignal?.aborted) return true;
  // A model may have stopped while a progress write failed. Its saved effect/checkpoint
  // rows and computer stay with this run; the next fenced attempt resumes them.
  lease.retainComputer = true;
  try {
    const released = await retryRunDatabaseOperation(ctx, () =>
      ctx.deps.prisma.run.updateMany({
        where: {
          id: ctx.runId,
          status: "running",
          leaseOwner: ctx.workerId,
          leaseFence: ctx.fence,
          leaseExpiresAt: { gt: new Date() },
        },
        data: {
          status: "queued",
          error: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          wakeAt: new Date(Date.now() + 3_000),
        },
      }),
    );
    ctx.stopHeartbeatAfterCompletion();
    if (released.count === 1) {
      // Interrupted attempts with no error neither count nor break setup failure streaks.
      await ctx.deps.prisma.attempt.updateMany({
        where: { id: ctx.attempt.id, status: "running" },
        data: { status: "setup_failed", error: null, finishedAt: new Date() },
      });
      await ctx.deps.jobs.enqueue({
        ...runContinueJob(ctx.runId),
        availableAt: new Date(Date.now() + 3_000),
      });
    }
  } catch (retryError) {
    // An outage beyond the lease or shutdown leaves durable recovery to reconciliation.
    if (!isDatabaseUnavailable(retryError) && !ctx.deps.shutdownSignal?.aborted) throw retryError;
  }
  return true;
}
