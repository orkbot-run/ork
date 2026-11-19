// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ComputerFrame } from "@orkbot/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { startComputerFrames } from "./computer-frames.js";
import { SCREEN_RECONNECT_DELAY_MS, SCREEN_RECONNECT_TRIES } from "./screen-reconnect.js";

const frame: ComputerFrame = {
  id: "a".repeat(64),
  capturedAt: "2026-11-13T10:00:00.000Z",
  data: "AQID",
  mimeType: "image/png",
  width: 2,
  height: 2,
};
afterEach(() => vi.useRealTimers());

it("bounds captures to one request and reuses only this subscription's previous frame", async () => {
  vi.useFakeTimers();
  let release!: (value: ComputerFrame) => void;
  const read = vi.fn(
    () =>
      new Promise<ComputerFrame | null>((resolve) => {
        release = resolve;
      }),
  );
  const onFrame = vi.fn();
  const stop = startComputerFrames({ read, onFrame, isCurrent: () => true, onError: vi.fn() });
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(1);
  release(frame);
  await vi.advanceTimersByTimeAsync(0);
  expect(onFrame).toHaveBeenCalledExactlyOnceWith(frame);
  await vi.advanceTimersByTimeAsync(500);
  expect(read).toHaveBeenLastCalledWith(frame.id, expect.any(AbortSignal));
  stop();
});

it.each(["cancel", "scope"])("does not deliver a late frame after %s", async (change) => {
  let release!: (value: ComputerFrame) => void;
  let active = true;
  const onFrame = vi.fn();
  const onError = vi.fn();
  const read = vi.fn(
    () =>
      new Promise<ComputerFrame>((resolve) => {
        release = resolve;
      }),
  );
  const stop = startComputerFrames({ read, onFrame, onError, isCurrent: () => active });
  if (change === "cancel") stop();
  else active = false;
  release(frame);
  await Promise.resolve();
  await Promise.resolve();
  expect(onFrame).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  stop();
});

it.each([401, 403, 404, 409])(
  "does not read an abandoned scope and reports status %s once",
  async (status) => {
    const read = vi.fn(async () => {
      throw Object.assign(new Error("Refused"), { status });
    });
    const onError = vi.fn();
    startComputerFrames({ read, onFrame: vi.fn(), onError, isCurrent: () => false })();
    expect(read).not.toHaveBeenCalled();
    const stop = startComputerFrames({ read, onFrame: vi.fn(), onError, isCurrent: () => true });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(read).toHaveBeenCalledOnce();
    stop();
  },
);

it("recovers from a transient failure with the last delivered frame", async () => {
  vi.useFakeTimers();
  const next = { ...frame, id: "b".repeat(64) };
  const read = vi
    .fn()
    .mockResolvedValueOnce(frame)
    .mockRejectedValueOnce(new TypeError("Network unavailable"))
    .mockResolvedValueOnce(next)
    .mockResolvedValue(null);
  const onFrame = vi.fn();
  const onError = vi.fn();
  const stop = startComputerFrames({ read, onFrame, onError, isCurrent: () => true });
  await vi.advanceTimersByTimeAsync(500);
  expect(read).toHaveBeenCalledTimes(2);
  expect(onFrame).toHaveBeenCalledExactlyOnceWith(frame);
  await vi.advanceTimersByTimeAsync(SCREEN_RECONNECT_DELAY_MS - 1);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenLastCalledWith(frame.id, expect.any(AbortSignal));
  expect(onFrame).toHaveBeenLastCalledWith(next);
  expect(onError).not.toHaveBeenCalled();
  stop();
});

it("bounds automatic retries and reports an ongoing outage once", async () => {
  vi.useFakeTimers();
  const error = Object.assign(new Error("Restarting"), { status: 503 });
  const read = vi.fn().mockRejectedValue(error);
  const onError = vi.fn();
  const stop = startComputerFrames({ read, onFrame: vi.fn(), onError, isCurrent: () => true });
  await vi.runAllTimersAsync();
  expect(read).toHaveBeenCalledTimes(SCREEN_RECONNECT_TRIES + 1);
  expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  expect(vi.getTimerCount()).toBe(0);
  stop();
});

it("cancels a stalled frame read so the screen can recover", async () => {
  vi.useFakeTimers();
  let stalled: AbortSignal | undefined;
  const read = vi
    .fn()
    .mockImplementationOnce((_previous: string | undefined, signal: AbortSignal) => {
      stalled = signal;
      return new Promise<ComputerFrame>(() => {});
    })
    .mockResolvedValueOnce(frame)
    .mockResolvedValue(null);
  const onFrame = vi.fn();
  const onError = vi.fn();
  const stop = startComputerFrames({ read, onFrame, onError, isCurrent: () => true });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(stalled?.aborted).toBe(true);
  expect(read).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(SCREEN_RECONNECT_DELAY_MS);
  expect(onFrame).toHaveBeenCalledExactlyOnceWith(frame);
  expect(onError).not.toHaveBeenCalled();
  stop();
});

it.each(["cancel", "scope"])("does not retry after %s during backoff", async (change) => {
  vi.useFakeTimers();
  let active = true;
  const read = vi.fn().mockRejectedValue(new Error("Network unavailable"));
  const onError = vi.fn();
  const stop = startComputerFrames({ read, onFrame: vi.fn(), onError, isCurrent: () => active });
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledOnce();
  if (change === "cancel") stop();
  else active = false;
  await vi.runAllTimersAsync();
  expect(read).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  stop();
});
