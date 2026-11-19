// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { RealtimeFanout } from "@orkbot/adapter-kit";

export interface RosterChanges {
  follow(
    scope: { userId: string; spaceId: string },
    signal: AbortSignal,
  ): AsyncGenerator<RosterSignal>;
}

export type RosterSignal = { type: "roster"; ready?: true };

/** Coalesce transient signals without storing an unbounded queue per connected client. */
export function createRosterChanges(realtime: RealtimeFanout): RosterChanges {
  return {
    async *follow({ userId, spaceId }, signal) {
      let activity = false;
      let roster = false;
      let lastSentAt = -Infinity;
      let wake: (() => void) | undefined;
      const subscribed: Array<() => Promise<void>> = [];
      const receive = (payload: string) => {
        if (payload === "activity") activity = true;
        else roster = true;
        wake?.();
      };
      try {
        for (const topic of [`roster:user:${userId}`, `roster:space:${spaceId}`]) {
          signal.throwIfAborted();
          subscribed.push(await realtime.subscribe(topic, receive));
        }
        if (signal.aborted) return;
        yield { type: "roster", ready: true };

        while (!signal.aborted) {
          const waitMs = (roster ? 3_000 : 10_000) - (performance.now() - lastSentAt);
          if ((roster || activity) && waitMs <= 0) {
            activity = false;
            roster = false;
            lastSentAt = performance.now();
            yield { type: "roster" };
            continue;
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          await new Promise<void>((resolve) => {
            if (roster || activity) timer = setTimeout(resolve, waitMs);
            wake = () => resolve();
            signal.addEventListener("abort", wake, { once: true });
            if (signal.aborted) resolve();
          }).finally(() => {
            clearTimeout(timer);
            if (wake) signal.removeEventListener("abort", wake);
            wake = undefined;
          });
        }
      } finally {
        await Promise.allSettled(subscribed.map((close) => close()));
      }
    },
  };
}
