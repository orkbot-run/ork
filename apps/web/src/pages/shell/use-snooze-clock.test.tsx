// @vitest-environment jsdom
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useSnoozeClock } from "./use-snooze-clock";

it("updates at the deadline and on foreground focus", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const refresh = vi.fn();
  let now = 0;
  function Probe() {
    now = useSnoozeClock(["2026-01-01T11:00:00Z"], refresh);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    act(() => root.render(<Probe />));
    act(() => vi.advanceTimersByTime(3_600_001));
    expect(now).toBe(Date.parse("2026-01-01T11:00:00Z") + 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(now).toBe(Date.parse("2026-01-01T12:00:00Z"));
    expect(refresh).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
