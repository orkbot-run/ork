// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type {
  MessagingOutboundList,
  MessagingOutboundResolution,
  MessagingOutboundReview,
} from "@orkbot/contracts";

type ReviewState = {
  opened: boolean;
  pending: boolean;
  items: MessagingOutboundReview[];
  error: unknown;
};

/** Review receipts belong to one loaded identity and never request a resend. */
export function createMessagingDeliveryReview(deps: {
  isCurrent: () => boolean;
  list: () => Promise<MessagingOutboundList>;
  resolve: (
    item: MessagingOutboundReview,
    resolution: MessagingOutboundResolution,
  ) => Promise<unknown>;
  refreshContext: () => Promise<void>;
}) {
  let state: ReviewState = { opened: false, pending: false, items: [], error: null };
  let revision = 0;
  const listeners = new Set<() => void>();
  function publish(next: ReviewState) {
    state = next;
    for (const listener of listeners) listener();
  }
  const current = (captured: number) => captured === revision && deps.isCurrent();
  async function load() {
    if (!deps.isCurrent() || state.pending) return;
    const captured = ++revision;
    publish({ ...state, opened: true, pending: true, error: null });
    try {
      const result = await deps.list();
      if (current(captured))
        publish({ opened: true, pending: false, items: result.items, error: null });
      if (result.items.length === 0 && current(captured)) await deps.refreshContext();
    } catch (error) {
      if (current(captured)) publish({ ...state, pending: false, error });
    }
  }
  async function resolve(item: MessagingOutboundReview, resolution: MessagingOutboundResolution) {
    if (
      !deps.isCurrent() ||
      state.pending ||
      !state.items.some((known) => known.id === item.id && known.version === item.version)
    )
      return;
    const captured = ++revision;
    publish({ ...state, pending: true, error: null });
    try {
      await deps.resolve(item, resolution);
    } catch (error) {
      if (current(captured)) publish({ ...state, pending: false, error });
      return;
    }
    if (!deps.isCurrent()) return;
    // Keep the confirmed decision even if refreshing the remaining queue fails.
    if (current(captured))
      publish({ ...state, items: state.items.filter((known) => known.id !== item.id) });
    const [remaining, context] = await Promise.allSettled([
      current(captured) ? deps.list() : Promise.resolve(undefined),
      deps.refreshContext(),
    ]);
    if (!current(captured)) return;
    publish({
      ...state,
      pending: false,
      items:
        remaining.status === "fulfilled" && remaining.value ? remaining.value.items : state.items,
      error:
        remaining.status === "rejected"
          ? remaining.reason
          : context.status === "rejected"
            ? context.reason
            : null,
    });
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    resolve,
    close() {
      revision += 1;
      publish({ opened: false, pending: false, items: [], error: null });
    },
  };
}
