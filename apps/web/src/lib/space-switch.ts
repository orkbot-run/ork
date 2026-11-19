// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 space switching is preserved. Immediate remount changes follow LICENSE.md.

import { useSyncExternalStore } from "react";
import type { NavigateFunction, NavigateOptions, To } from "react-router-dom";

/**
 * Switching spaces in place: the shell is keyed by this counter, so a switch
 * throws away every piece of the previous space's state, as a reload would,
 * without reloading the page.
 */
let epoch = 0;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSpaceEpoch(): number {
  return useSyncExternalStore(subscribe, () => epoch);
}

/** Selects the new space and remounts its shell in the current React update. */
export function remountShellForSpace(commit: () => boolean): void {
  if (!commit()) return;
  epoch += 1;
  for (const listener of listeners) listener();
}

/** Async work from a departing shell must not move the next shell's route. */
export function guardShellNavigate(
  getNavigate: () => NavigateFunction,
  isAlive: () => boolean,
): NavigateFunction {
  return (to: To | number, options?: NavigateOptions) => {
    if (!isAlive()) return;
    const navigate = getNavigate();
    return typeof to === "number" ? navigate(to) : navigate(to, options);
  };
}

export function spaceSwitchDecision(
  currentRequest: boolean,
  startedPathname: string,
  pathname: string,
  hasCall: boolean,
): "abandon" | "reload" | "commit" {
  if (!currentRequest || pathname !== startedPathname) return "abandon";
  return hasCall ? "reload" : "commit";
}
