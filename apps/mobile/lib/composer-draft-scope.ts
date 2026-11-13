// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useEffect, useState } from "react";
import { currentApiBase, subscribeApiBase } from "./api";
import { artifactCacheSession } from "./artifact-cache-session";
import type { ComposerDraftScope } from "./composer-draft";
import {
  clearComposerDrafts,
  composerDraftScope,
  isComposerDraftScopeCurrent,
} from "./composer-draft";
import { clearComposerDraftAttachments } from "./composer-draft-attachments";
import {
  currentReadySessionGeneration,
  currentSessionGeneration,
  loadSessionToken,
  registerSessionDiskCache,
  subscribeSessionGeneration,
} from "./session";
import {
  clearWorkspaceDraftSession,
  hydrateWorkspaceDraftSession,
} from "./workspace-draft-session";

registerSessionDiskCache((sameAccount, reason) => {
  clearWorkspaceDraftSession();
  if (reason === "workspace_switch") return;
  const includeManaged = reason === "logout" || reason === "account_switch";
  if (!sameAccount && reason !== "session_rejected") clearComposerDraftAttachments(includeManaged);
  if (includeManaged || reason === "session_restore") clearComposerDrafts(includeManaged);
});

/** A late authentication read never assigns a new login lifetime to a captured source. */
export function useComposerDraftScope(
  userId: string,
  botId: string | undefined,
  groupId: string | undefined,
  verifiedGeneration: number,
) {
  const [scope, setScope] = useState<ComposerDraftScope | undefined>(() =>
    verifiedGeneration === currentSessionGeneration() &&
    verifiedGeneration === currentReadySessionGeneration()
      ? composerDraftScope(userId, botId, groupId)
      : undefined,
  );
  useEffect(() => {
    let revision = 0;
    const hydrate = async () => {
      const owner = ++revision;
      const generation = currentSessionGeneration();
      const apiBase = currentApiBase();
      if (
        generation !== verifiedGeneration ||
        currentReadySessionGeneration() !== verifiedGeneration
      ) {
        setScope(undefined);
        return;
      }
      try {
        const token = await loadSessionToken();
        if (
          owner !== revision ||
          generation !== currentSessionGeneration() ||
          apiBase !== currentApiBase()
        )
          return;
        if (!token) return setScope(undefined);
        await artifactCacheSession(token);
        await hydrateWorkspaceDraftSession(
          () =>
            owner === revision &&
            generation === currentSessionGeneration() &&
            apiBase === currentApiBase(),
        );
        if (
          owner !== revision ||
          generation !== currentSessionGeneration() ||
          apiBase !== currentApiBase()
        )
          return;
        setScope(composerDraftScope(userId, botId, groupId));
      } catch {
        if (owner === revision) setScope(undefined);
      }
    };
    void hydrate();
    const session = subscribeSessionGeneration(() => void hydrate());
    const server = subscribeApiBase(() => void hydrate());
    return () => {
      revision++;
      session();
      server();
    };
  }, [userId, botId, groupId, verifiedGeneration]);
  return verifiedGeneration === currentSessionGeneration() &&
    verifiedGeneration === currentReadySessionGeneration() &&
    scope &&
    isComposerDraftScopeCurrent(scope) &&
    scope.userId === userId &&
    scope.threadKey === (groupId ? `group:${groupId}` : `bot:${botId}`)
    ? scope
    : undefined;
}
