// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it } from "vitest";
import { messageReasoningThinkingLevel, parseMessageReasoningPreset } from "./message-reasoning.js";

describe("per-message reasoning commands", () => {
  it.each(["quick", "standard", "deep"] as const)("parses %s with a task body", (preset) => {
    expect(parseMessageReasoningPreset(`/think ${preset}\nSummarize this.`)).toEqual({
      preset,
      text: "Summarize this.",
    });
    expect(parseMessageReasoningPreset(`/think ${preset} Summarize this.`)).toEqual({
      preset,
      text: "Summarize this.",
    });
  });

  it("preserves body formatting and subsequent commands", () => {
    expect(
      parseMessageReasoningPreset("/think deep\r\n\r\nReview:\n  code\n/think quick\n"),
    ).toEqual({
      preset: "deep",
      text: "Review:\n  code\n/think quick\n",
    });
  });

  it.each([
    "/quick Explain this.",
    "/deep Explain this.",
    "/think deeply Explain this.",
    "/think deep-skill Explain this.",
    "/think DEEP Explain this.",
    "/think  deep Explain this.",
    "Quote: /think deep Explain this.",
    " /think deep Explain this.",
    "/think deep",
    "/think quick\n ",
    "Explain this.",
  ])("leaves ordinary input unchanged: %s", (prompt) => {
    expect(parseMessageReasoningPreset(prompt)).toBeNull();
  });
});

describe("reasoning effort within the selected model", () => {
  it.each([
    ["quick", "low"],
    ["standard", "medium"],
    ["deep", "high"],
  ] as const)("maps %s to %s", (preset, level) => {
    expect(messageReasoningThinkingLevel(preset)).toBe(level);
  });
});
