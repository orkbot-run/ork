// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it } from "vitest";
import type { Evidence } from "./cases.js";
import {
  TOOL_HISTORY_CASES,
  TOOL_HISTORY_FIXTURE_VERSION,
  TOOL_HISTORY_JUDGE_CALIBRATION,
  TOOL_HISTORY_JUDGE_VERSION,
} from "./tool-history.js";

describe("tool history eval contract", () => {
  it("places tool work before the prepared compaction boundary and omits it from the control", () => {
    const [recent, compacted, absent] = TOOL_HISTORY_CASES;
    expect(recent!.history!.messages).toHaveLength(8);
    expect(compacted!.history!.messages).toHaveLength(100);
    expect(compacted!.history!.version).toBe(TOOL_HISTORY_FIXTURE_VERSION);
    expect(compacted!.history!.messages[3]!.toolSteps).toHaveLength(2);
    expect(compacted!.history!.summary!.upToSeq).toBeGreaterThan(3);
    expect(compacted!.history!.summary!.text).not.toContain("Lyra");
    expect(absent!.history!.messages.every((message) => !message.toolSteps)).toBe(true);
  });

  it("requires history access after compaction and qualifies both judge rubrics with labels", () => {
    const withoutSearch = { text: "reply", toolCalls: [], finalStep: 1 } as unknown as Evidence;
    const withSearch = {
      ...withoutSearch,
      toolCalls: [{ step: 1, name: "search_history", args: {} }],
    };
    for (const scenario of TOOL_HISTORY_CASES) {
      const judge = scenario.judge!(withoutSearch);
      expect(judge.rubric.startsWith(`${TOOL_HISTORY_JUDGE_VERSION}:`)).toBe(true);
      expect(judge.evidence).toEqual({ reply: "reply" });
      const anchors = TOOL_HISTORY_JUDGE_CALIBRATION.filter(
        (item) => item.input.rubric === judge.rubric,
      );
      expect(new Set(anchors.map((item) => item.pass))).toEqual(new Set([true, false]));
      if (scenario.id !== "tool-history-recent") {
        expect(scenario.grade(withoutSearch)[0]!.pass).toBe(false);
        expect(scenario.grade(withSearch)[0]!.pass).toBe(true);
      }
    }
  });
});
