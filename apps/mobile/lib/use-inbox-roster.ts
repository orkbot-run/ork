// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { abortableDelay, isRetryableError, retryDelayMs } from "@orkbot/core";
import { useEffect, useRef } from "react";
import { subscribeRosterEvents } from "./api";
import { useAppForeground } from "./app-foreground";
import { INBOX_POLL_INTERVAL_MS } from "./poll-cadence";

const READY_POLL_MS = 60_000;
const INITIAL_READY_GRACE_MS = 2_000;
const COALESCE_MS = 100;

/** One foreground inbox refresh at a time, with slower reconciliation once SSE is ready. */
export function useInboxRoster(run: () => Promise<unknown>, enabled: boolean): void {
  const foreground = useAppForeground();
  const runRef = useRef(run);
  runRef.current = run;
  const pendingRef = useRef<Promise<unknown> | null>(null);

  useEffect(() => {
    if (!enabled || !foreground) return;
    const controller = new AbortController();
    const started = Date.now();
    let ready = false;
    let dirty = false;
    let polling = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;
    const current = () => !controller.signal.aborted;
    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      clearTimer();
      if (current() && polling)
        timer = setTimeout(() => void refresh(), ready ? READY_POLL_MS : INBOX_POLL_INTERVAL_MS);
    };
    const invalidate = () => {
      if (!current() || !polling) return;
      dirty = true;
      if (refreshing) return;
      clearTimer();
      timer = setTimeout(() => void refresh(), COALESCE_MS);
    };
    const refresh = async () => {
      if (!current() || refreshing || !polling) return;
      refreshing = true;
      dirty = false;
      const pending = pendingRef.current ?? (async () => runRef.current())();
      pendingRef.current = pending;
      try {
        const result = await pending;
        if (result === false) polling = false;
      } catch {
        // The inbox reports load failures; keep its last good snapshot and retry cadence.
      } finally {
        if (pendingRef.current === pending) pendingRef.current = null;
        refreshing = false;
        if (current()) {
          if (dirty) invalidate();
          else schedule();
        }
      }
    };
    void refresh();
    void (async () => {
      let attempts = 0;
      while (current()) {
        let failure: unknown;
        try {
          await subscribeRosterEvents((event) => {
            if (!current()) return;
            if (event.ready) {
              if (ready) return;
              ready = true;
              // A prompt first ready is covered by the initial snapshot. A reconnect or
              // delayed listener may have missed changes, so reconcile those immediately.
              if (attempts > 0 || Date.now() - started > INITIAL_READY_GRACE_MS) invalidate();
              else if (!refreshing && !dirty) schedule();
            } else invalidate();
          }, controller.signal);
        } catch (error) {
          failure = error;
        }
        if (!current()) return;
        const wasReady = ready;
        ready = false;
        if (wasReady && !refreshing && !dirty) schedule();
        if (failure && !isRetryableError(failure)) return;
        const delay = retryDelayMs(failure, Math.min(1_000 * 2 ** attempts, 5_000));
        attempts += 1;
        await abortableDelay(delay, controller.signal).catch(() => undefined);
      }
    })();
    return () => {
      controller.abort();
      clearTimer();
    };
  }, [enabled, foreground]);
}
