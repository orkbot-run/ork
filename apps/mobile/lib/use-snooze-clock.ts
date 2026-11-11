// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { useEffect, useState } from "react";
import { AppState } from "react-native";

/** Wake the inbox at the next deadline and recheck after the app resumes. */
export function useSnoozeClock(
  deadlines: readonly (string | null | undefined)[],
  refresh: () => void,
): number {
  const [now, setNow] = useState(Date.now);
  const nearest = deadlines.reduce<number | null>((best, value) => {
    const time = value ? Date.parse(value) : NaN;
    return Number.isFinite(time) && time > now && (best === null || time < best) ? time : best;
  }, null);
  useEffect(() => {
    if (nearest === null) return;
    const timer = setTimeout(
      () => {
        setNow(Date.now());
        refresh();
      },
      Math.max(0, Math.min(nearest - Date.now() + 1, 2_147_483_647)),
    );
    return () => clearTimeout(timer);
  }, [nearest, now, refresh]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setNow(Date.now());
        refresh();
      }
    });
    return () => subscription.remove();
  }, [refresh]);
  return now;
}
