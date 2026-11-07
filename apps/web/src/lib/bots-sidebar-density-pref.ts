// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved; shared preference integration follows LICENSE.md.

import { browserPreference, preferenceStorage } from "./persisted-preference";

export type BotsSidebarDensity = "comfortable" | "compact";
export const BOTS_SIDEBAR_DENSITY_STORAGE_KEY = "orkbot.botsSidebarDensity";

export function normalizeBotsSidebarDensity(raw: string | null | undefined): BotsSidebarDensity {
  return raw?.trim().toLowerCase() === "compact" ? "compact" : "comfortable";
}
const preference = browserPreference(BOTS_SIDEBAR_DENSITY_STORAGE_KEY, normalizeBotsSidebarDensity);

export function readBotsSidebarDensity(
  storage: Pick<Storage, "getItem"> | null = preferenceStorage(),
): BotsSidebarDensity {
  return preference.read(() => storage?.getItem(BOTS_SIDEBAR_DENSITY_STORAGE_KEY) ?? null);
}
export function persistBotsSidebarDensity(
  density: BotsSidebarDensity,
  storage: Pick<Storage, "setItem"> | null = preferenceStorage(),
): void {
  preference.persist(normalizeBotsSidebarDensity(density), (serialized) => {
    if (!storage) return false;
    storage.setItem(BOTS_SIDEBAR_DENSITY_STORAGE_KEY, serialized);
    return true;
  });
}
export const getBotsSidebarDensity: () => BotsSidebarDensity = preference.get;
export function setBotsSidebarDensity(density: BotsSidebarDensity): BotsSidebarDensity {
  return preference.set(normalizeBotsSidebarDensity(density));
}
export const subscribeBotsSidebarDensity = preference.subscribe;
