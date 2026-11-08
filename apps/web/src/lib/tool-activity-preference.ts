// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved; shared preference integration follows LICENSE.md.

import { browserPreference, preferenceStorage } from "./persisted-preference";

export type ToolActivityPreference = "on" | "off";
export const TOOL_ACTIVITY_STORAGE_KEY = "orkbot.showToolActivity";
export type ResolveToolActivityOptions = {
  stored?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
};

/** Only a saved "on" shows tool cards. Missing or unreadable storage stays off so chats stay clean. */
export function normalizeToolActivityPreference(
  raw: string | null | undefined,
): ToolActivityPreference {
  return raw?.trim().toLowerCase() === "on" ? "on" : "off";
}

export function toolActivityEnabled(preference: ToolActivityPreference = "off"): boolean {
  return preference === "on";
}

const preference = browserPreference(TOOL_ACTIVITY_STORAGE_KEY, normalizeToolActivityPreference);

export function resolveToolActivityPreference(
  options: ResolveToolActivityOptions = {},
): ToolActivityPreference {
  return options.stored !== undefined
    ? normalizeToolActivityPreference(options.stored)
    : preference.read(
        () => (options.storage ?? preferenceStorage())?.getItem(TOOL_ACTIVITY_STORAGE_KEY) ?? null,
      );
}
export function persistToolActivityPreference(
  value: ToolActivityPreference,
  storage: Pick<Storage, "setItem"> | null = preferenceStorage(),
): void {
  preference.persist(value, (serialized) => {
    if (!storage) return false;
    storage.setItem(TOOL_ACTIVITY_STORAGE_KEY, serialized);
    return true;
  });
}
export const getToolActivityPreference: () => ToolActivityPreference = preference.get;
export const setToolActivityPreference: (value: ToolActivityPreference) => ToolActivityPreference =
  preference.set;
export const subscribeToolActivity = preference.subscribe;
export function getToolActivityEnabled(): boolean {
  return toolActivityEnabled(getToolActivityPreference());
}
