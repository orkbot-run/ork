// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved; shared preference integration follows LICENSE.md.

import type { RemoteImagesPreference } from "@orkbot/core";
import {
  createPersistedPreference,
  normalizeRemoteImagesPreference,
  REMOTE_IMAGES_STORAGE_KEY,
} from "@orkbot/core";
import * as SecureStore from "expo-secure-store";

export type { RemoteImagesPreference };

const preference = createPersistedPreference({ normalize: normalizeRemoteImagesPreference });

export function getCachedRemoteImagesEnabled(): boolean {
  return preference.get() === "on";
}
export function loadRemoteImagesPreference(): Promise<RemoteImagesPreference> {
  return preference.load(() => SecureStore.getItemAsync(REMOTE_IMAGES_STORAGE_KEY));
}
export function setRemoteImagesPreference(
  value: RemoteImagesPreference,
): Promise<RemoteImagesPreference> {
  return preference.save(value, (serialized) =>
    SecureStore.setItemAsync(REMOTE_IMAGES_STORAGE_KEY, serialized),
  );
}
export const subscribeRemoteImages = preference.subscribe;
