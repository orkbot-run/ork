// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ThinkingLevel } from "@orkbot/contracts";

export type MessageReasoningPreset = "quick" | "standard" | "deep";

const PRESET_LEVELS = {
  quick: "low",
  standard: "medium",
  deep: "high",
} as const satisfies Record<MessageReasoningPreset, ThinkingLevel>;

/** An explicit first-line command; existing skill commands and quoted text stay untouched. */
export function parseMessageReasoningPreset(
  prompt: string,
): { preset: MessageReasoningPreset; text: string } | null {
  const match = /^\/think (quick|standard|deep)(?:[ \t]+|\r?\n|$)/.exec(prompt);
  if (!match) return null;
  const text = prompt.slice(match[0].length).trimStart();
  // A preset alone is not a task, so keep it as ordinary input.
  if (!text.trim()) return null;
  return { preset: match[1] as MessageReasoningPreset, text };
}

/** The runtime clamps the request to the selected model's capabilities. */
export function messageReasoningThinkingLevel(preset: MessageReasoningPreset): ThinkingLevel {
  return PRESET_LEVELS[preset];
}
