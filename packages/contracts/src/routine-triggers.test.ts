// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it } from "vitest";
import { CreateRoutineInput } from "./domain.js";
import { RoutineMessageProviderSchema, routineTriggerIssue } from "./routine-triggers.js";

describe("shared routine triggers", () => {
  it.each([{ webhookEnabled: true }, { githubEnabled: true }, { messageProvider: "telegram" }])(
    "accepts an event without a schedule: %j",
    (trigger) => {
      expect(routineTriggerIssue({ crons: [], ...trigger })).toBeUndefined();
      expect(
        CreateRoutineInput.safeParse({ botId: "bot", name: "Events", prompt: "Check", ...trigger })
          .success,
      ).toBe(true);
    },
  );
  it("rejects missing triggers and cron plus change triggers", () => {
    expect(routineTriggerIssue({ crons: [] })?.path).toBe("crons");
    expect(routineTriggerIssue({ crons: ["* * * * *"], watch: {} })?.path).toBe("watch");
  });
  it("keeps the editor's provider character and length constraints", () => {
    expect(RoutineMessageProviderSchema.safeParse("custom.Provider_1-test").success).toBe(true);
    for (const value of ["", "a".repeat(51), "bad provider", "../telegram/"]) {
      expect(RoutineMessageProviderSchema.safeParse(value).success).toBe(false);
    }
  });
});
