// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved; shared activity identity follows LICENSE.md.

import type { RunActivityRow } from "@orkbot/contracts";
import { isRunWaitingOnUser, isRunWorking } from "./run-state.js";
import { isAgedStuckWork } from "./stuck-work.js";

type ActivityRun = Pick<RunActivityRow, "botId" | "groupId" | "status" | "updatedAt">;
type ActivityBot = { id: string; unread: boolean };
type ActivityGroup = { id: string; unread: boolean };

/** A question or forgotten queue wins over work, and an unread failure is something to look at. */
export function activityAttention(
  run: ActivityRun,
  unread = false,
): "needs_attention" | "working" | "unread" | null {
  if (isRunWaitingOnUser(run.status) || isAgedStuckWork(run.status, run.updatedAt))
    return "needs_attention";
  if (isRunWorking(run.status)) return "working";
  if (!unread) return null;
  return run.status === "failed" ? "needs_attention" : "unread";
}

/** A group is one chat regardless of which member bot produced its run. */
export function activityChatKey(run: Pick<RunActivityRow, "botId" | "groupId">): string {
  return run.groupId ? `group:${run.groupId}` : `bot:${run.botId}`;
}

/** Splits activity into what needs the user, what is running, unread chats, and the rest. */
export function activitySections<
  Run extends ActivityRun,
  Bot extends ActivityBot,
  Group extends ActivityGroup,
>({
  active,
  recent,
  bots,
  groups,
}: {
  active: readonly Run[];
  recent: readonly Run[];
  bots: readonly Bot[];
  groups: readonly Group[];
}) {
  const unreadChats = new Set([
    ...bots.filter((bot) => bot.unread).map((bot) => `bot:${bot.id}`),
    ...groups.filter((group) => group.unread).map((group) => `group:${group.id}`),
  ]);
  const runUnread = (run: Run) => unreadChats.has(activityChatKey(run));
  // One run speaks for each chat: a question first, then live work, then the latest outcome
  // (`recent` is newest first).
  const byChat = new Map<string, Run>();
  const waiting = active.filter((run) => activityAttention(run) === "needs_attention");
  for (const run of [...waiting, ...active, ...recent]) {
    if (!byChat.has(activityChatKey(run))) byChat.set(activityChatKey(run), run);
  }
  const latest = [...byChat.values()];
  const attention = latest.filter(
    (run) => activityAttention(run, runUnread(run)) === "needs_attention",
  );
  const working = latest.filter((run) => activityAttention(run, runUnread(run)) === "working");
  const busy = new Set([...attention, ...working].map(activityChatKey));
  return {
    attention,
    working,
    unreadGroups: groups.filter((group) => group.unread && !busy.has(`group:${group.id}`)),
    unreadBots: bots.filter((bot) => bot.unread && !busy.has(`bot:${bot.id}`)),
    recent: recent.filter((run) => !attention.includes(run) && !runUnread(run)),
  };
}
