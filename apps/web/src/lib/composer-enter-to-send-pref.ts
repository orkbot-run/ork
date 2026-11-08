// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved; shared preference integration follows LICENSE.md.

import { browserPreference, preferenceStorage } from "./persisted-preference";

export const COMPOSER_ENTER_TO_SEND_STORAGE_KEY = "orkbot.runposerEnterToSend";
type EnterToSendStorage = Pick<Storage, "getItem" | "setItem">;

function detectCoarsePointer(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches
    );
  } catch {
    return false;
  }
}

/** Default: Enter sends on desktop and inserts a newline on touch devices. */
export function defaultComposerEnterToSend(coarsePointer = detectCoarsePointer()): boolean {
  return !coarsePointer;
}

export function normalizeComposerEnterToSend(
  raw: string | null | undefined,
  coarsePointer: boolean = detectCoarsePointer(),
): boolean {
  if (raw == null) return defaultComposerEnterToSend(coarsePointer);
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "on") return true;
  if (value === "0" || value === "false" || value === "off") return false;
  return defaultComposerEnterToSend(coarsePointer);
}

const preference = browserPreference(
  COMPOSER_ENTER_TO_SEND_STORAGE_KEY,
  normalizeComposerEnterToSend,
  (value) => (value ? "1" : "0"),
);

export function getComposerEnterToSend(
  storage: EnterToSendStorage | null = preferenceStorage(),
  coarsePointer?: boolean,
): boolean {
  return preference.initialize(
    () => storage?.getItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY) ?? null,
    (raw) => normalizeComposerEnterToSend(raw, coarsePointer),
  );
}
export function setComposerEnterToSend(
  value: boolean,
  storage: EnterToSendStorage | null = preferenceStorage(),
): boolean {
  return preference.set(value, (serialized) => {
    if (!storage) return false;
    storage.setItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY, serialized);
    return true;
  });
}
export const subscribeComposerEnterToSend = preference.subscribe;
