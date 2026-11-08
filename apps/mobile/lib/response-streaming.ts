// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved; shared preference integration follows LICENSE.md.

import type { ResponseStreamingPreference } from "@orkbot/core";
import {
  createPersistedPreference,
  normalizeResponseStreamingPreference,
  RESPONSE_STREAMING_STORAGE_KEY,
  responseStreamingEnabled,
} from "@orkbot/core";
import * as SecureStore from "expo-secure-store";

export type { ResponseStreamingPreference };

const preference = createPersistedPreference({ normalize: normalizeResponseStreamingPreference });

export const getCachedResponseStreamingPreference: () => ResponseStreamingPreference =
  preference.get;
export function getCachedResponseStreamingEnabled(): boolean {
  return responseStreamingEnabled(preference.get());
}
export function loadResponseStreamingPreference(): Promise<ResponseStreamingPreference> {
  return preference.load(() => SecureStore.getItemAsync(RESPONSE_STREAMING_STORAGE_KEY));
}
export function setResponseStreamingPreference(
  value: ResponseStreamingPreference,
): Promise<ResponseStreamingPreference> {
  return preference.save(value, (serialized) =>
    SecureStore.setItemAsync(RESPONSE_STREAMING_STORAGE_KEY, serialized),
  );
}
export const subscribeResponseStreaming = preference.subscribe;
