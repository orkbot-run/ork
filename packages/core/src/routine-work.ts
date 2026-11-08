// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { RUN_ROUTINE_NAME_MAX_LENGTH } from "@orkbot/contracts";
import { displayName } from "./display-name.js";
import { truncatePlainText } from "./markdown-plain.js";
import { isRunWaitingOnUser, isRunWorking } from "./run-state.js";

export function runRoutineDisplayName(value: unknown): string | null {
  return typeof value === "string"
    ? truncatePlainText(displayName(value, ""), RUN_ROUTINE_NAME_MAX_LENGTH) || null
    : null;
}

/** A name is displayable only in the run's actual owned routine and thread. */
export function projectRunRoutineName(
  run: {
    routineId: string | null;
    userId: string;
    spaceId: string;
    botId: string;
    threadId: string;
    trigger?: string;
    clientNonce?: string | null;
  },
  routine:
    | {
        id: string;
        name: string;
        userId: string;
        spaceId: string;
        botId: string;
        threadId: string | null;
      }
    | null
    | undefined,
  thread: { id: string; botId: string | null; groupId: string | null },
): string | null {
  if (
    !routine ||
    !run.routineId ||
    routine.id !== run.routineId ||
    routine.userId !== run.userId ||
    routine.spaceId !== run.spaceId ||
    routine.botId !== run.botId ||
    thread.id !== run.threadId
  )
    return null;
  const sameThread = routine.threadId === run.threadId;
  const legacyDirect =
    routine.threadId === null && thread.botId === run.botId && thread.groupId === null;
  const testPrefix = `routine-run:${run.userId}:`;
  const manualDirect =
    run.trigger === "routine" &&
    thread.botId === run.botId &&
    thread.groupId === null &&
    Boolean(run.clientNonce?.startsWith(testPrefix) && run.clientNonce.length > testPrefix.length);
  return sameThread || legacyDirect || manualDirect ? runRoutineDisplayName(routine.name) : null;
}

export type RoutineWorkContext = { names: string[]; stopName: string | null; stopAll: boolean };

/** Labels derive from the same active runs the existing Stop action cancels. */
export function routineWorkContext(
  runs: readonly {
    id: string;
    status: string;
    routineId?: string | null;
    routineName?: string | null;
  }[],
): RoutineWorkContext {
  const active = runs.filter((run) => isRunWorking(run.status) || isRunWaitingOnUser(run.status));
  const names = [
    ...new Set(
      active.flatMap((run) => {
        const name = run.routineId ? runRoutineDisplayName(run.routineName) : null;
        return name ? [name] : [];
      }),
    ),
  ];
  return {
    names,
    stopName: active.length === 1 && names.length === 1 ? names[0]! : null,
    stopAll: active.length > 1 && names.length > 0,
  };
}
