// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Removed unused exports. Inherited material remains Apache-2.0.

import * as z from "zod";

export const BotReplyModeSchema = z.enum(["chat", "explicit"]);
export type BotReplyMode = z.infer<typeof BotReplyModeSchema>;

/** Shared section membership and order; surfaces omit unavailable capabilities. */
export const BOT_SETTINGS_SECTIONS = {
  openWork: ["scratchpad"],
  memory: ["knowledge"],
  advanced: [
    "model",
    "thinking",
    "replyMode",
    "computer",
    "memoryScope",
    "readAloud",
    "voice",
    "dailyCheckIns",
    "crossSpaceCommunication",
    "fleetManagement",
    "instructions",
    "description",
    "disabledTools",
    "credentials",
    "skills",
    "export",
    "clear",
  ],
} as const;

/** Labels stay literal in each platform's translation calls. */
export const BOT_COMPUTER_MODES = ["team", "dedicated"] as const;
