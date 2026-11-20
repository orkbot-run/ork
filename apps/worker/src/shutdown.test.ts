// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterEach, expect, it, vi } from "vitest";
import {
  createWorkerShutdown,
  WORKER_SHUTDOWN_IO_MS,
  waitForWorkerShutdownIo,
} from "./shutdown.js";

function fixture(runDrainMs?: number) {
  const shutdown = new AbortController();
  let finish!: () => void;
  const ongoing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stopWork = vi.fn(() => ongoing);
  const closeResources = vi.fn(async () => undefined);
  const timeout = vi.fn();
  const stop = createWorkerShutdown({
    shutdown,
    runDrainMs,
    stopWork,
    closeResources,
    onRunDrainTimeout: timeout,
    flush: async () => undefined,
  });
  return { stop, shutdown, finish, stopWork, closeResources, timeout };
}

afterEach(() => vi.useRealTimers());

it("keeps the active turn and its dependencies until it finishes", async () => {
  vi.useFakeTimers();
  const f = fixture(40);
  const stopping = f.stop(true);
  expect(f.stopWork).toHaveBeenCalledOnce();
  expect(f.stop(true)).toBe(stopping);
  await vi.advanceTimersByTimeAsync(20);
  expect(f.shutdown.signal.aborted).toBe(false);
  expect(f.closeResources).not.toHaveBeenCalled();
  f.finish();
  await stopping;
  await vi.advanceTimersByTimeAsync(40);
  expect(f.timeout).not.toHaveBeenCalled();
  expect(f.shutdown.signal.aborted).toBe(true);
  expect(f.closeResources).toHaveBeenCalledOnce();
});

it("interrupts at the deadline and waits for the turn to be handed back", async () => {
  vi.useFakeTimers();
  const f = fixture(40);
  const stopping = f.stop(true);
  await vi.advanceTimersByTimeAsync(40);
  expect(f.shutdown.signal.aborted).toBe(true);
  expect(f.timeout).toHaveBeenCalledOnce();
  expect(f.closeResources).not.toHaveBeenCalled();
  f.finish();
  await stopping;
  expect(f.closeResources).toHaveBeenCalledOnce();
});

it("interrupts immediately without opt-in or when a fault occurs during a drain", async () => {
  const off = fixture();
  const notDraining = off.stop(true);
  expect(off.shutdown.signal.aborted).toBe(true);
  off.finish();
  await notDraining;

  const draining = fixture(40);
  const graceful = draining.stop(true);
  expect(draining.stop()).toBe(graceful);
  expect(draining.shutdown.signal.aborted).toBe(true);
  draining.finish();
  await graceful;
  expect(draining.timeout).not.toHaveBeenCalled();
});

it("bounds a stalled shutdown I/O step", async () => {
  vi.useFakeTimers();
  const timeout = vi.fn();
  const closing = waitForWorkerShutdownIo(new Promise<void>(() => undefined), timeout);
  await vi.advanceTimersByTimeAsync(WORKER_SHUTDOWN_IO_MS);
  await closing;
  expect(timeout).toHaveBeenCalledOnce();
});
