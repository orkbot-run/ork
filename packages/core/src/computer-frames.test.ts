// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ComputerFrame } from "@orkbot/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { startComputerFrames } from "./computer-frames.js";

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

it("does not read an abandoned scope and reports an authorization error once", async () => {
  const read = vi.fn(async () => {
    throw new Error("Forbidden");
  });
  const onError = vi.fn();
  startComputerFrames({ read, onFrame: vi.fn(), onError, isCurrent: () => false })();
  expect(read).not.toHaveBeenCalled();
  const stop = startComputerFrames({ read, onFrame: vi.fn(), onError, isCurrent: () => true });
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(read).toHaveBeenCalledOnce();
  stop();
});
