// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Modified by Ork contributors. Inherited Apache material and new PolyForm changes.

import { BOT_DESCRIPTION_MAX_LENGTH, BOT_NAME_MAX_LENGTH } from "@orkbot/contracts";
import type { OwnBotSettingsRow } from "./own-bot-settings.js";

export type UpdateBotPatch = {
  name?: string;
  description?: string;
  color?: string;
  notifyOnFinish?: boolean;
  dailyCheckIns?: boolean;
};

function hasUpdateBotAvatarArgs(args: Record<string, unknown>): boolean {
  return (
    args.color !== undefined || args.artifact_id !== undefined || args.use_attached_image === true
  );
}

export function parseUpdateBotPatch(
  args: Record<string, unknown>,
): { error: string } | { patch: UpdateBotPatch } {
  const patch: UpdateBotPatch = {};
  if (args.name !== undefined) patch.name = String(args.name);
  if (args.description !== undefined) patch.description = String(args.description);
  if (args.dailyCheckIns !== undefined) {
    if (typeof args.dailyCheckIns !== "boolean")
      return { error: "dailyCheckIns must be true or false." };
    patch.dailyCheckIns = args.dailyCheckIns;
  }
  const notifyRaw = args.notifyOnFinish !== undefined ? args.notifyOnFinish : args.notify_on_finish;
  if (notifyRaw !== undefined) {
    if (typeof notifyRaw !== "boolean") {
      return { error: "notifyOnFinish must be true or false." };
    }
    patch.notifyOnFinish = notifyRaw;
  }
  if (Object.keys(patch).length === 0 && !hasUpdateBotAvatarArgs(args)) {
    return {
      error:
        "Provide at least one of name, description, notifyOnFinish, color, artifact_id, or use_attached_image.",
    };
  }
  if (patch.name !== undefined) {
    const nextName = patch.name.trim();
    if (!nextName) return { error: "name cannot be empty." };
    if (nextName.length > BOT_NAME_MAX_LENGTH) {
      return { error: `name must be at most ${BOT_NAME_MAX_LENGTH} characters.` };
    }
    patch.name = nextName;
  }
  if (patch.description !== undefined) {
    const nextDescription = patch.description.trim();
    if (nextDescription.length > BOT_DESCRIPTION_MAX_LENGTH) {
      return { error: `description must be at most ${BOT_DESCRIPTION_MAX_LENGTH} characters.` };
    }
    patch.description = nextDescription;
  }
  return { patch };
}

/** Providers send omitted optional fields as null or blank; only anything else counts as given. */
export function argumentGiven(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

/** Only the caller's exact id is interchangeable with an omitted own-profile target. */
export function normalizeOwnBotTarget(
  args: Record<string, unknown>,
  botId: string,
): Record<string, unknown> {
  if (args.bot_id !== botId) return args;
  const { bot_id: _self, ...own } = args;
  return own;
}

/** Zero is the ordinary call; a positive offset always requests an instructions page. */
export function ownBotInstructionsOffset(
  args: Record<string, unknown>,
): number | { error: string } {
  const value = args.instructions_offset ?? args.instructionsOffset;
  if (!argumentGiven(value)) return 0;
  const offset = Number(value);
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    return { error: "instructions_offset must be a whole number of 0 or more." };
  return offset;
}

/** Compare only the values this bot's settings read can echo, preserving actual changes. */
export function dropUnchangedOwnBotArgs(
  args: Record<string, unknown>,
  bot: OwnBotSettingsRow,
  model?: { provider: string | null; model: string | null; label: string },
): Record<string, unknown> {
  const remaining = Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) =>
        key !== "instructions_offset" && key !== "instructionsOffset" && argumentGiven(value),
    ),
  );
  // Preserve the canonical field's precedence when both spellings are supplied.
  const notify = remaining.notifyOnFinish ?? remaining.notify_on_finish;
  delete remaining.notify_on_finish;
  if (notify !== undefined) remaining.notifyOnFinish = notify;
  for (const key of ["notifyOnFinish", "dailyCheckIns", "readAloud", "use_attached_image"]) {
    const value = remaining[key];
    if (typeof value === "string" && ["true", "false"].includes(value.trim().toLowerCase()))
      remaining[key] = value.trim().toLowerCase() === "true";
  }
  const current = {
    name: bot.name,
    description: bot.description,
    instructions: bot.instructions,
    color: bot.color,
    thinkingLevel: bot.thinkingLevel ?? "default",
    voice: bot.voiceId ?? "default",
  };
  for (const [key, value] of Object.entries(remaining)) {
    const text = typeof value === "string" ? value.trim() : undefined;
    if (
      (Object.hasOwn(current, key) &&
        text !== undefined &&
        text === current[key as keyof typeof current].trim()) ||
      (key === "notifyOnFinish" && value === bot.notifyOnFinish) ||
      (key === "dailyCheckIns" && value === bot.dailyCheckIns) ||
      (key === "readAloud" && value === bot.autoSpeak) ||
      (key === "use_attached_image" && value === false) ||
      (key === "model" &&
        text !== undefined &&
        model &&
        [
          ...(model.model ? [model.model] : []),
          ...(model.provider && model.model ? [`${model.provider}/${model.model}`] : []),
          model.label,
        ].includes(text))
    )
      delete remaining[key];
  }
  return remaining;
}
