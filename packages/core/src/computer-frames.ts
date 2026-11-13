// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ComputerFrame } from "@orkbot/contracts";
import { COMPUTER_FRAME_INTERVAL_MS } from "@orkbot/contracts";
import { abortableDelay, withAbort } from "./async.js";

/** An internal viewer selection, never a network address or a provider capability. */
export const COMPUTER_FRAME_SOURCE = "ork-frame://computer";

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
  async function run() {
    try {
      while (current()) {
        const frame = await withAbort(options.read(previous, controller.signal), controller.signal);
        if (!current()) return;
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
