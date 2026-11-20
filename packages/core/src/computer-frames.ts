// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ComputerFrame } from "@orkbot/contracts";
import { COMPUTER_FRAME_INTERVAL_MS } from "@orkbot/contracts";
import { abortableDelay, requestDeadline, withAbort } from "./async.js";
import { isRetryableError, retryDelayMs } from "./retry-policy.js";
import { SCREEN_RECONNECT_DELAY_MS, SCREEN_RECONNECT_TRIES } from "./screen-reconnect.js";

/** An internal viewer selection, never a network address or a provider capability. */
export const COMPUTER_FRAME_SOURCE = "ork-frame://computer";
const FRAME_READ_TIMEOUT_MS = 10_000;

/** Read at most one frame at a time and retire delivery before waiting for network cleanup. */
export function startComputerFrames(options: {
  read(previous: string | undefined, signal: AbortSignal): Promise<ComputerFrame | null>;
  isCurrent(): boolean;
  onFrame(frame: ComputerFrame): void;
  onError(error: unknown): void;
}): () => void {
  const controller = new AbortController();
  const current = () => !controller.signal.aborted && options.isCurrent();
  let previous: string | undefined;
  let failures = 0;
  async function readFrame() {
    const request = requestDeadline(
      FRAME_READ_TIMEOUT_MS,
      "The screen did not respond.",
      controller.signal,
    );
    try {
      return await withAbort(options.read(previous, request.signal), request.signal);
    } finally {
      request.dispose();
    }
  }

  async function run() {
    try {
      while (current()) {
        let frame: ComputerFrame | null;
        try {
          frame = await readFrame();
        } catch (error) {
          if (!current()) return;
          if (!isRetryableError(error) || failures >= SCREEN_RECONNECT_TRIES) throw error;
          const delay = retryDelayMs(error, SCREEN_RECONNECT_DELAY_MS * 2 ** failures);
          failures += 1;
          await abortableDelay(delay, controller.signal);
          continue;
        }
        if (!current()) return;
        failures = 0;
        if (frame) {
          previous = frame.id;
          options.onFrame(frame);
        }
        await abortableDelay(COMPUTER_FRAME_INTERVAL_MS, controller.signal);
      }
    } catch (error) {
      if (current()) options.onError(error);
    }
  }
  void run();
  return () => controller.abort();
}
