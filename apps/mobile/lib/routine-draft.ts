// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-License-Identifier: Apache-2.0

import type { Routine, RpcInput } from "@orkbot/contracts";
import { ROUTINE_WATCH_DEFAULT_MINUTES, RoutineWatchSchema } from "@orkbot/contracts";
import type { CronPreset } from "@orkbot/core";
import { cronFromPreset, isOneShotRoutineCrons, presetFromCron } from "@orkbot/core";
import { routineTriggerNames } from "./routine";

type HttpWatchDraft = { url: string; track: string; everyMinutes: string; loud: boolean };

export type RoutineDraft = {
  name: string;
  prompt: string;
  schedules: CronPreset[];
  active: boolean;
  httpWatch: HttpWatchDraft | null;
};

export function emptyRoutineHttpWatch(): HttpWatchDraft {
  return { url: "", track: "", everyMinutes: String(ROUTINE_WATCH_DEFAULT_MINUTES), loud: false };
}

export function emptyRoutineDraft(): RoutineDraft {
  return { name: "", prompt: "", schedules: [], active: true, httpWatch: null };
}

export function draftFromRoutine(routine: Routine): RoutineDraft {
  return {
    name: routine.name,
    prompt: routine.prompt,
    schedules: routine.crons.map(presetFromCron),
    active: routine.active,
    httpWatch:
      routine.watch?.kind === "http"
        ? {
            url: routine.watch.url ?? "",
            track: (routine.watch.track ?? []).join(", "),
            everyMinutes: String(routine.watch.everyMinutes),
            loud: routine.watch.loud,
          }
        : null,
  };
}

/** A one-shot is set up from chat with its run time; its schedule can't change here. */
export function routineScheduleLocked(routine: Routine | null): boolean {
  return Boolean(routine && isOneShotRoutineCrons(routine.crons));
}

function sameCrons(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((cron, index) => cron === b[index]);
}

/** What an update would change, compared as the editor writes it. */
function routineChanges(draft: RoutineDraft, routine: Routine) {
  const crons = draft.schedules.map(cronFromPreset);
  // A schedule merely opened is not a change, even when the editor would spell it differently.
  const saved = draftFromRoutine(routine);
  const savedCrons = saved.schedules.map(cronFromPreset);
  return {
    ...(draft.name !== routine.name ? { name: draft.name.trim() } : {}),
    ...(draft.prompt !== routine.prompt ? { prompt: draft.prompt.trim() } : {}),
    ...(!routineScheduleLocked(routine) && !sameCrons(crons, savedCrons) ? { crons } : {}),
    ...(draft.active !== routine.active ? { active: draft.active } : {}),
    ...(JSON.stringify(draft.httpWatch) !== JSON.stringify(saved.httpWatch)
      ? { httpWatchChanged: true as const }
      : {}),
  };
}

/** Whether there is anything to save: a change to the routine, or anything in a new one. */
export function routineDraftChanged(draft: RoutineDraft, routine: Routine | null): boolean {
  if (!routine)
    return Boolean(
      draft.name.trim() || draft.prompt.trim() || draft.schedules.length || draft.httpWatch,
    );
  return Object.keys(routineChanges(draft, routine)).length > 0;
}

export type RoutineSaveRequest =
  | { error: "name" | "prompt" | "trigger" | "watchUrl" | "watchSettings" }
  | { create: RpcInput<"routines/create"> }
  | { update: RpcInput<"routines/update"> }
  | { unchanged: true };

/**
 * The create or update call for a draft. An update sends only what the draft changed, so a
 * stale draft never undoes a pause or edit made elsewhere since it opened.
 */
export function routineSaveRequest(
  draft: RoutineDraft,
  routine: Routine | null,
  botId: string,
  timezone: string,
): RoutineSaveRequest {
  const name = draft.name.trim();
  const prompt = draft.prompt.trim();
  if (!name) return { error: "name" };
  if (!prompt) return { error: "prompt" };
  const crons = draft.schedules.map(cronFromPreset);
  const remainingTriggers =
    routine &&
    routineTriggerNames({
      ...routine,
      watch: routine.watch?.kind === "http" ? null : routine.watch,
    }).length;
  if (crons.length === 0 && !draft.httpWatch && !remainingTriggers) {
    return { error: "trigger" };
  }
  let watch = null;
  if (draft.httpWatch) {
    const track = draft.httpWatch.track
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);
    const parsed = RoutineWatchSchema.safeParse({
      kind: "http",
      url: draft.httpWatch.url,
      track: track.length ? track : undefined,
      everyMinutes: Number(draft.httpWatch.everyMinutes),
      loud: draft.httpWatch.loud,
    });
    if (!parsed.success) {
      return {
        error: parsed.error.issues.some((issue) => issue.path[0] === "url")
          ? "watchUrl"
          : "watchSettings",
      };
    }
    watch = parsed.data;
  }
  if (!routine) {
    return {
      create: {
        botId,
        name,
        prompt,
        crons,
        timezone,
        active: draft.active,
        notify: true,
        ...(watch ? { watch } : {}),
      },
    };
  }
  const { httpWatchChanged, ...update } = routineChanges(draft, routine);
  if (!httpWatchChanged && !Object.keys(update).length) return { unchanged: true };
  return { update: { routineId: routine.id, ...update, ...(httpWatchChanged ? { watch } : {}) } };
}
