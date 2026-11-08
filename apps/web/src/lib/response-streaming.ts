// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved; shared preference integration follows LICENSE.md.

import type { ResponseStreamingPreference } from "@orkbot/core";
import {
  normalizeResponseStreamingPreference,
  RESPONSE_STREAMING_STORAGE_KEY,
  responseStreamingEnabled,
} from "@orkbot/core";
import { browserPreference, preferenceStorage } from "./persisted-preference";

export type { ResponseStreamingPreference };
export type ResolveResponseStreamingOptions = {
  stored?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
};

const preference = browserPreference(
  RESPONSE_STREAMING_STORAGE_KEY,
  normalizeResponseStreamingPreference,
);

/** Saved choice wins. Nothing saved leaves streaming off. */
export function resolveResponseStreamingPreference(
  options: ResolveResponseStreamingOptions = {},
): ResponseStreamingPreference {
  return options.stored !== undefined
    ? normalizeResponseStreamingPreference(options.stored)
    : preference.read(
        () =>
          (options.storage ?? preferenceStorage())?.getItem(RESPONSE_STREAMING_STORAGE_KEY) ?? null,
      );
}

export function persistResponseStreamingPreference(
  value: ResponseStreamingPreference,
  storage: Pick<Storage, "setItem"> | null = preferenceStorage(),
): void {
  preference.persist(value, (serialized) => {
    if (!storage) return false;
    storage.setItem(RESPONSE_STREAMING_STORAGE_KEY, serialized);
    return true;
  });
}

export const getResponseStreamingPreference: () => ResponseStreamingPreference = preference.get;
export const setResponseStreamingPreference: (
  value: ResponseStreamingPreference,
) => ResponseStreamingPreference = preference.set;
export const subscribeResponseStreaming = preference.subscribe;

export function getResponseStreamingEnabled(): boolean {
  return responseStreamingEnabled(getResponseStreamingPreference());
}
