// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createServerUpdates } from "@orkbot/core";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { authClient } from "./auth";
import { rpc } from "./rpc";

export function useServerUpdates(poll: boolean) {
  const session = authClient.useSession().data;
  const key = session
    ? JSON.stringify([location.origin, session.user.id, session.session.id])
    : null;
  const context = useRef(key);
  context.current = key;
  const updates = useMemo(
    () =>
      createServerUpdates({
        context: () => (context.current === key ? key : null),
        status: (signal) => rpc.serverUpdates.status(undefined, { signal }),
        check: (signal) => rpc.serverUpdates.check({}, { signal }),
        apply: (input, signal) => rpc.serverUpdates.apply(input, { signal }),
        policy: (input, signal) => rpc.serverUpdates.policy(input, { signal }),
      }),
    [key],
  );
  const state = useSyncExternalStore(updates.subscribe, updates.getSnapshot, updates.getSnapshot);
  useEffect(() => {
    let stop = document.visibilityState === "hidden" ? () => {} : updates.watch(poll);
    const visible = () => {
      stop();
      stop = document.visibilityState === "hidden" ? () => {} : updates.watch(poll);
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [updates, poll]);
  return { updates, state };
}
