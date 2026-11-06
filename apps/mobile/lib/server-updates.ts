// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createServerUpdates } from "@orkbot/core";
import { randomUUID } from "expo-crypto";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { currentApiBase, rpc } from "./api";
import { currentSessionGeneration, subscribeSessionGeneration } from "./session";

export function useServerUpdates(poll: boolean) {
  const generation = useSyncExternalStore(
    subscribeSessionGeneration,
    currentSessionGeneration,
    currentSessionGeneration,
  );
  const key = JSON.stringify([currentApiBase(), generation]);
  const updates = useMemo(
    () =>
      createServerUpdates({
        context: () =>
          key === JSON.stringify([currentApiBase(), currentSessionGeneration()]) ? key : null,
        status: (signal) => rpc("serverUpdates/status", undefined, { signal }),
        check: (signal) => rpc("serverUpdates/check", {}, { signal }),
        apply: (input, signal) => rpc("serverUpdates/apply", input, { signal }),
        policy: (input, signal) => rpc("serverUpdates/policy", input, { signal }),
        id: randomUUID,
      }),
    [key],
  );
  const state = useSyncExternalStore(updates.subscribe, updates.getSnapshot, updates.getSnapshot);
  useEffect(() => {
    let stop = AppState.currentState === "background" ? () => {} : updates.watch(poll);
    const subscription = AppState.addEventListener("change", (value) => {
      stop();
      stop = value === "active" ? updates.watch(poll) : () => {};
    });
    return () => {
      stop();
      subscription.remove();
    };
  }, [updates, poll]);
  return { updates, state };
}
