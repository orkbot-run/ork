// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited settings tests are preserved; reply-mode validation is an Ork addition.

import { describe, expect, it } from "vitest";
import {
  BOT_COMPUTER_MODES,
  BOT_SETTINGS_SECTIONS,
  BotReplyModeSchema,
} from "./bot-settings-layout.js";
import type { ComputerMode } from "./domain.js";
import { UpdateBotInput } from "./domain.js";

describe("bot settings layout", () => {
  it("accepts only the shared reply modes while preserving omitted updates", () => {
    expect(BotReplyModeSchema.options).toEqual(["chat", "explicit"]);
    expect(UpdateBotInput.parse({ botId: "bot" })).not.toHaveProperty("replyMode");
    expect(UpdateBotInput.safeParse({ botId: "bot", replyMode: "unknown" }).success).toBe(false);
    expect(UpdateBotInput.parse({ botId: "bot", replyMode: "explicit" })).toHaveProperty(
      "replyMode",
      "explicit",
    );
  });
  it("offers Team before Private using valid computer modes", () => {
    const modes: readonly ComputerMode[] = BOT_COMPUTER_MODES;
    expect(modes).toEqual(["team", "dedicated"]);
  });
  it("assigns each control to one section", () => {
    const controls = Object.values(BOT_SETTINGS_SECTIONS).flat();
    expect(new Set(controls).size).toBe(controls.length);
  });
});
