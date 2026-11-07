// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";

export const HAPTICS_KEY = "orkbot.haptics";
let enabled: boolean | undefined;
let revision = 0;
let loading: Promise<boolean> | undefined;
let writing: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export const getHapticsEnabled = () => enabled;
export function subscribeHaptics(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** An unreadable or absent device preference leaves optional feedback off. */
export function loadHapticsEnabled(): Promise<boolean> {
  if (enabled !== undefined) return Promise.resolve(enabled);
  if (loading) return loading;
  const seen = revision;
  const pending = SecureStore.getItemAsync(HAPTICS_KEY)
    .then(
      (value) => value === "1",
      () => false,
    )
    .then((value) => {
      if (revision === seen) {
        enabled = value;
        emit();
      }
      return enabled ?? false;
    })
    .finally(() => {
      if (loading === pending) loading = undefined;
    });
  loading = pending;
  return pending;
}

/** Disable immediately; opt-in takes effect only after its local write succeeds. */
export async function saveHapticsEnabled(value: boolean): Promise<void> {
  const seen = ++revision;
  enabled = false;
  emit();
  const pending = writing.then(() => SecureStore.setItemAsync(HAPTICS_KEY, value ? "1" : "0"));
  writing = pending.catch(() => undefined);
  await pending;
  if (revision === seen) {
    enabled = value;
    emit();
  }
}

/** Only custom controls call this; native menus, switches and call ringing own their feedback. */
export function selectionHaptic(): void {
  if (
    enabled !== true ||
    AppState.currentState !== "active" ||
    !["ios", "android"].includes(Platform.OS)
  )
    return;
  const seen = revision;
  void import("expo-haptics")
    .then((haptics) => {
      if (enabled !== true || revision !== seen || AppState.currentState !== "active") return;
      return Platform.OS === "android"
        ? haptics.performAndroidHapticsAsync(haptics.AndroidHaptics.Segment_Tick)
        : haptics.selectionAsync();
    })
    .catch(() => undefined);
}
