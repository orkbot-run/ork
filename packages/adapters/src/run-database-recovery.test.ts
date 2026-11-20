// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import {
  recoverRunFromDatabaseOutage,
  retryRunDatabaseOperation,
} from "./run-database-recovery.js";

afterEach(() => vi.useRealTimers());

function context() {
  const run = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
  const attempt = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const lease = {
    valid: true,
    completed: false,
    retainComputer: false,
    databaseDeadline: Date.now() + 10_000,
  };
  const ctx = {
    deps: { prisma: { run, attempt }, jobs: { enqueue } },
    runId: "run-db",
    workerId: "worker-db",
    fence: 7,
    attempt: { id: "attempt-db" },
    state: { lease },
    stopHeartbeatAfterCompletion: vi.fn(() => {
      lease.completed = true;
    }),
  } as unknown as RunContext;
  return { ctx, run, attempt, enqueue, lease };
}

describe("run database recovery", () => {
  it("requeues a fenced run after a short outage, preserving its computer and setup budget", async () => {
    vi.useFakeTimers();
    const { ctx, run, attempt, enqueue, lease } = context();
    run.updateMany.mockRejectedValueOnce({ code: "57P01" });
    const recovering = recoverRunFromDatabaseOutage(ctx, { code: "57P01" });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(recovering).resolves.toBe(true);
    expect(run.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "run-db",
          leaseOwner: "worker-db",
          leaseFence: 7,
          leaseExpiresAt: { gt: expect.any(Date) },
        }),
        data: expect.objectContaining({ status: "queued", error: null }),
      }),
    );
    expect(lease.retainComputer).toBe(true);
    expect(attempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "setup_failed", error: null }),
      }),
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("does not publish or mutate attempts after the lease was lost", async () => {
    const { ctx, run, enqueue, lease } = context();
    lease.valid = false;
    expect(await recoverRunFromDatabaseOutage(ctx, { code: "57P01" })).toBe(true);
    expect(run.updateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("stops persistence retries by the confirmed lease deadline and shutdown", async () => {
    vi.useFakeTimers();
    const { ctx, lease } = context();
    lease.databaseDeadline = Date.now() + 2_000;
    const persist = vi.fn().mockRejectedValue({ code: "57P01" });
    const waiting = retryRunDatabaseOperation(ctx, persist);
    const assertion = expect(waiting).rejects.toMatchObject({ code: "57P01" });
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(persist).toHaveBeenCalledTimes(2);
    const shutdown = new AbortController();
    shutdown.abort();
    ctx.deps.shutdownSignal = shutdown.signal;
    await expect(retryRunDatabaseOperation(ctx, persist)).rejects.toBeDefined();
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("leaves ordinary failures unchanged", async () => {
    const { ctx, run } = context();
    expect(await recoverRunFromDatabaseOutage(ctx, new Error("ordinary error"))).toBe(false);
    expect(run.updateMany).not.toHaveBeenCalled();
  });
});
