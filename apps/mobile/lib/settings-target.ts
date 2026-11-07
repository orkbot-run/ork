// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; model configuration changes follow LICENSE.md.

import type { RpcPath } from "@orkbot/contracts";
import type { RpcArgs } from "./api";
import {
  captureApiRequestContext,
  currentApiBase,
  rpc,
  selectedSpaceId,
  spaceSelectionSeq,
} from "./api";
import { currentSessionGeneration } from "./session";

/** Which copy a settings screen edits: the account's, or one Space's override. */
export type SettingsTarget = { scope: "account" } | { scope: "space"; spaceId: string };

export const ACCOUNT_SETTINGS: SettingsTarget = { scope: "account" };

/** A connection flow binds once, before any readiness, credential or sign-in request. */
export function captureSettingsContext(target: SettingsTarget) {
  const generation = currentSessionGeneration();
  const apiBase = currentApiBase();
  const selection = spaceSelectionSeq();
  const sourceSpace = selectedSpaceId();
  const requestContext = captureApiRequestContext(
    target.scope === "space" ? target.spaceId : sourceSpace,
  ).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const isCurrent = () =>
    generation === currentSessionGeneration() &&
    apiBase === currentApiBase() &&
    selection === spaceSelectionSeq() &&
    sourceSpace === selectedSpaceId();
  const send: typeof rpc = async <P extends RpcPath>(proc: P, ...[body, options]: RpcArgs<P>) => {
    if (!isCurrent()) throw new Error("Session changed");
    const prepared = await requestContext;
    if ("error" in prepared) throw prepared.error;
    const context = prepared.value;
    if (!isCurrent()) throw new Error("Session changed");
    const result = await rpc(
      proc,
      ...([
        body,
        { ...options, requestContext: context, skipSpaceAuthRecovery: true },
      ] as RpcArgs<P>),
    );
    if (!isCurrent()) throw new Error("Session changed");
    return result;
  };
  return { send, isCurrent };
}

/** A screen opened with a Space edits that Space's override; without one, the account's. */
export function settingsTarget(spaceId: string | string[] | undefined): SettingsTarget {
  return typeof spaceId === "string" && spaceId ? { scope: "space", spaceId } : ACCOUNT_SETTINGS;
}

/**
 * Calls for a settings screen. A Space override is sent to that Space even when another one is
 * selected, so its settings can be edited from the inbox's Space menu without switching.
 */
export function settingsRpc(target: SettingsTarget): typeof rpc {
  if (target.scope === "account") return rpc;
  const { spaceId } = target;
  return async <P extends RpcPath>(proc: P, ...[body, options]: RpcArgs<P>) => {
    const requestContext = await captureApiRequestContext(spaceId);
    return rpc(proc, ...([body, { ...options, requestContext }] as RpcArgs<P>));
  };
}
