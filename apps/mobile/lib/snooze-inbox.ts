// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { RunActivityRow } from "@orkbot/contracts";
import { threadSnoozeState } from "@orkbot/core";

type Chat = { id: string; snoozedUntil?: string | null };

export function visibleSnoozes<T extends Chat>(chats: T[], now: number): T[] {
  return chats.filter((chat) => threadSnoozeState(chat.snoozedUntil, now) !== "snoozed");
}

export function visibleSnoozedActivity(
  activity: { active: RunActivityRow[]; recent: RunActivityRow[] },
  bots: readonly Chat[],
  groups: readonly Chat[],
  now: number,
) {
  const hiddenBots = new Set(
    bots
      .filter((bot) => threadSnoozeState(bot.snoozedUntil, now) === "snoozed")
      .map((bot) => bot.id),
  );
  const hiddenGroups = new Set(
    groups
      .filter((group) => threadSnoozeState(group.snoozedUntil, now) === "snoozed")
      .map((group) => group.id),
  );
  const visible = (run: RunActivityRow) =>
    run.groupId ? !hiddenGroups.has(run.groupId) : !hiddenBots.has(run.botId);
  return { active: activity.active.filter(visible), recent: activity.recent.filter(visible) };
}
