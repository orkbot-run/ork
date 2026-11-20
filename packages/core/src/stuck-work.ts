// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited stuck-work behavior is preserved. Configurable thresholds follow LICENSE.md.

import { displayName } from "./display-name.js";
/** Default age for a reminder, and the fixed age marker in the activity list.
 *  Long enough that a short queue or stepping away stays quiet; short enough
 *  that forgotten work is not silent until the next day. */
export const STUCK_WORK_NOTIFY_AFTER_MS = 4 * 60 * 60 * 1000;

/** Default cancellation age for that same work.
 *  Leaves the hours after the reminder for someone to answer before the thread is freed. */
export const STUCK_WORK_EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Resolve on use so shared core stays safe in renderers without a Node process. */
export function stuckWorkThresholds(
  env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env,
): { notifyAfterMs: number; expireAfterMs: number } {
  const expireAfterMs = thresholdMs(env.STUCK_WORK_EXPIRE_AFTER_MS, STUCK_WORK_EXPIRE_AFTER_MS);
  return {
    notifyAfterMs: Math.min(
      thresholdMs(env.STUCK_WORK_NOTIFY_AFTER_MS, STUCK_WORK_NOTIFY_AFTER_MS),
      expireAfterMs,
    ),
    expireAfterMs,
  };
}

function thresholdMs(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return fallback;
  const ms = Number(value);
  return Number.isSafeInteger(ms) && ms >= 60_000 && ms <= 30 * 24 * 60 * 60 * 1000 ? ms : fallback;
}

/** A takeover request nobody acted on is cancelled much sooner: it holds the bot's computer,
 *  so later work for that bot waits behind it. This expiration stays fixed. */
export const TAKEOVER_WAIT_EXPIRE_AFTER_MS = 30 * 60 * 1000;

/** Marker on a thread.meta event so a reminder is sent once per waiting episode. */
export const STUCK_WORK_NOTICE = "stuck";

export const STUCK_WORK_STATUSES = ["queued", "waiting_input", "waiting_takeover"] as const;
export type StuckWorkStatus = (typeof STUCK_WORK_STATUSES)[number];

export type StuckWorkAction = "notify" | "expire" | "none";

export function isStuckWorkStatus(status: string): status is StuckWorkStatus {
  return (STUCK_WORK_STATUSES as readonly string[]).includes(status);
}

export function stuckWorkAgeMs(updatedAt: Date | string, now: Date): number {
  const at = updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(updatedAt);
  if (!Number.isFinite(at)) return 0;
  return now.getTime() - at;
}

/** How long a run in this status may sit before the first reminder or cancellation. */
export function stuckWorkDueAfterMs(status: StuckWorkStatus): number {
  if (status === "waiting_takeover") return TAKEOVER_WAIT_EXPIRE_AFTER_MS;
  return stuckWorkThresholds().notifyAfterMs;
}

/** `alreadyNotified` is for this episode (the run's current updatedAt), not an older one. */
export function stuckWorkAction(input: {
  status: StuckWorkStatus;
  ageMs: number;
  alreadyNotified: boolean;
}): StuckWorkAction {
  if (input.status === "waiting_takeover") {
    return input.ageMs >= TAKEOVER_WAIT_EXPIRE_AFTER_MS ? "expire" : "none";
  }
  const thresholds = stuckWorkThresholds();
  if (input.ageMs >= thresholds.expireAfterMs) return "expire";
  if (input.ageMs >= thresholds.notifyAfterMs && !input.alreadyNotified) return "notify";
  return "none";
}

/** True once a queued or human-waiting run is old enough to call out in the activity list. */
export function isAgedStuckWork(
  status: string,
  updatedAt: Date | string,
  now = Date.now(),
): boolean {
  if (!isStuckWorkStatus(status)) return false;
  return stuckWorkAgeMs(updatedAt, new Date(now)) >= STUCK_WORK_NOTIFY_AFTER_MS;
}

export function stuckWorkExpiredNonce(runId: string): string {
  return `stuck-expired:${runId}`;
}

/** Status line left in the thread when the wait is cancelled. */
export function stuckWorkStatusMessage(status: StuckWorkStatus): string {
  switch (status) {
    case "queued":
      return "Stopped. This stayed queued without starting.";
    case "waiting_input":
      return "Stopped. This was still waiting for an answer.";
    case "waiting_takeover":
      return "Stopped. This was still waiting for you on the screen.";
  }
}

export function stuckWorkStatusMessages(): readonly string[] {
  return STUCK_WORK_STATUSES.map((status) => stuckWorkStatusMessage(status));
}

export type StuckAttentionKind = "help" | "takeover" | "failure";

export function stuckWorkReminder(
  status: StuckWorkStatus,
  botName: string,
): { kind: StuckAttentionKind; title: string; body: string } {
  const name = botLabel(botName);
  switch (status) {
    case "queued":
      return {
        kind: "help",
        title: `${name} is still queued`,
        body: "It has been waiting to start.",
      };
    case "waiting_input":
      return {
        kind: "help",
        title: `${name} still needs an answer`,
        body: "This has been waiting on you.",
      };
    case "waiting_takeover":
      return {
        kind: "takeover",
        title: `${name} still needs you`,
        body: "The screen has been waiting.",
      };
  }
}

export function stuckWorkStoppedNotification(
  status: StuckWorkStatus,
  botName: string,
): { kind: "failure"; title: string; body: string } {
  return {
    kind: "failure",
    title: `${botLabel(botName)} stopped`,
    body: stuckWorkStatusMessage(status),
  };
}

function botLabel(name: string): string {
  return displayName(name, "Bot");
}
