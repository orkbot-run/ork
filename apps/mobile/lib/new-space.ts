// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { ApiRequestContext, RpcOptions } from "./api";
import {
  captureApiRequestContext,
  currentApiBase,
  rpc,
  selectedSpaceId,
  selectSpace,
  spaceSelectionSeq,
} from "./api";
import { currentSessionGeneration } from "./session";

/** A creation sheet retains its Space across onboarding retries and never follows a new session. */
export function newSpaceCreation() {
  const apiBase = currentApiBase();
  const generation = currentSessionGeneration();
  const sourceSpaceId = selectedSpaceId();
  const selection = spaceSelectionSeq();
  let context: ApiRequestContext | undefined;
  let createdSpaceId: string | undefined;

  return async (
    name: string,
    isActive: () => boolean,
  ): Promise<"ready" | "selection_failed" | "stale"> => {
    const sameSession = () =>
      isActive() && apiBase === currentApiBase() && generation === currentSessionGeneration();
    const current = () =>
      sameSession() && sourceSpaceId === selectedSpaceId() && selection === spaceSelectionSeq();
    if (!current()) return "stale";
    try {
      context ??= await captureApiRequestContext(sourceSpaceId);
      if (!current()) return "stale";
      if (!createdSpaceId) {
        const space = await rpc("spaces/create", { name }, { requestContext: context });
        createdSpaceId = space.id;
      }
      if (!current()) return "stale";
      // Keep the creation's bearer and server while addressing its new Space explicitly.
      const options: RpcOptions = {
        requestContext: {
          ...context,
          headers: { ...context.headers, "x-orkbot-space-id": createdSpaceId },
        },
        skipSpaceAuthRecovery: true,
      };
      await rpc("onboarding/ensureFirstBot", undefined, options);
      if (!current()) return "stale";
      const selected = await selectSpace(createdSpaceId).catch(() => false);
      if (!sameSession() || spaceSelectionSeq() !== selection + 1) return "stale";
      if (!selected) return sourceSpaceId === selectedSpaceId() ? "selection_failed" : "stale";
      return createdSpaceId === selectedSpaceId() ? "ready" : "stale";
    } catch (error) {
      if (!current()) return "stale";
      throw error;
    }
  };
}
