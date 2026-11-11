// @vitest-environment jsdom
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSnoozeClock } from "./use-snooze-clock";

const app = vi.hoisted(() => ({ listener: undefined as ((state: string) => void) | undefined }));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_: string, listener: (state: string) => void) => {
      app.listener = listener;
      return {
        remove: () => {
          app.listener = undefined;
        },
      };
    },
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

it("updates at the deadline and checks again on foreground resume", () => {
  const refresh = vi.fn();
  let clock = 0;
  function Probe() {
    clock = useSnoozeClock(["2026-01-01T11:00:00Z"], refresh);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  act(() => vi.advanceTimersByTime(3_600_001));
  expect(clock).toBe(Date.parse("2026-01-01T11:00:00Z") + 1);
  expect(refresh).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  act(() => app.listener?.("active"));
  expect(clock).toBe(Date.parse("2026-01-01T12:00:00Z"));
  expect(refresh).toHaveBeenCalledTimes(2);
  act(() => root.unmount());
});
