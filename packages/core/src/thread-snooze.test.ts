// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it } from "vitest";
import { snoozeUntil, threadSnoozeState } from "./thread-snooze.js";

describe("thread snooze", () => {
  it("uses elapsed hours for short presets", () => {
    const now = new Date(2026, 2, 28, 23, 30);
    expect(snoozeUntil("hour_1", now).getTime() - now.getTime()).toBe(3_600_000);
    expect(snoozeUntil("hour_3", now).getTime() - now.getTime()).toBe(10_800_000);
  });
  it("uses nine in the local calendar tomorrow and on the next Monday", () => {
    const saturday = new Date(2026, 2, 28, 12);
    expect(snoozeUntil("tomorrow_9", saturday)).toEqual(new Date(2026, 2, 29, 9));
    expect(snoozeUntil("monday_9", saturday)).toEqual(new Date(2026, 2, 30, 9));
    const monday = new Date(2026, 2, 30, 8);
    expect(snoozeUntil("monday_9", monday)).toEqual(new Date(2026, 3, 6, 9));
  });
  it("distinguishes future, elapsed and invalid timestamps", () => {
    const now = Date.parse("2026-03-29T08:00:00Z");
    expect(threadSnoozeState("2026-03-29T08:00:01Z", now)).toBe("snoozed");
    expect(threadSnoozeState("2026-03-29T08:00:00Z", now)).toBe("woken");
    expect(threadSnoozeState("broken", now)).toBe("none");
    expect(threadSnoozeState(null, now)).toBe("none");
  });
});
