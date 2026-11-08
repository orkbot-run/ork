// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved; shared preference integration follows LICENSE.md.

import type { RemoteImagesPreference } from "@orkbot/core";
import { normalizeRemoteImagesPreference, REMOTE_IMAGES_STORAGE_KEY } from "@orkbot/core";
import { browserPreference } from "./persisted-preference";

export type { RemoteImagesPreference };

const preference = browserPreference(REMOTE_IMAGES_STORAGE_KEY, normalizeRemoteImagesPreference);

export const getRemoteImagesPreference: () => RemoteImagesPreference = preference.get;
export const setRemoteImagesPreference: (value: RemoteImagesPreference) => RemoteImagesPreference =
  preference.set;
export const subscribeRemoteImages = preference.subscribe;

export function getRemoteImagesEnabled(): boolean {
  return getRemoteImagesPreference() === "on";
}
