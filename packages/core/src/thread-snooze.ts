// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

export type SnoozePreset = "hour_1" | "hour_3" | "tomorrow_9" | "monday_9";

/** Presets use elapsed hours or the device's local calendar, respectively. */
export function snoozeUntil(preset: SnoozePreset, now = new Date()): Date {
  if (preset === "hour_1" || preset === "hour_3")
    return new Date(now.getTime() + (preset === "hour_1" ? 1 : 3) * 60 * 60 * 1000);
  const result = new Date(now);
  const days = preset === "tomorrow_9" ? 1 : (8 - now.getDay()) % 7 || 7;
  result.setDate(result.getDate() + days);
  result.setHours(9, 0, 0, 0);
  return result;
}

export function threadSnoozeState(
  until: string | null | undefined,
  now = Date.now(),
): "none" | "snoozed" | "woken" {
  if (!until) return "none";
  const deadline = Date.parse(until);
  return Number.isFinite(deadline) ? (deadline > now ? "snoozed" : "woken") : "none";
}
