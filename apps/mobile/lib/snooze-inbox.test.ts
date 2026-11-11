// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { expect, it } from "vitest";
import { visibleSnoozedActivity, visibleSnoozes } from "./snooze-inbox";

it("hides future snoozes from inbox and activity and reveals them on time", () => {
  const now = Date.parse("2026-01-01T10:00:00Z");
  const bots = [{ id: "bot", snoozedUntil: "2026-01-01T11:00:00Z" }];
  const groups = [{ id: "group", snoozedUntil: "2026-01-01T11:00:00Z" }];
  const activity = {
    active: [
      { botId: "bot", runId: "a" },
      { botId: "peer", groupId: "group", runId: "b" },
    ] as never,
    recent: [],
  };
  expect(visibleSnoozes(bots, now)).toEqual([]);
  expect(visibleSnoozedActivity(activity, bots, groups, now).active).toEqual([]);
  expect(visibleSnoozes(bots, now + 3_600_000)).toEqual(bots);
  expect(visibleSnoozedActivity(activity, bots, groups, now + 3_600_000).active).toHaveLength(2);
});
