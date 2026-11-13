// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 draft storage is preserved. Verified migration and ownership follow LICENSE.md.

import type { ComposerMentionBinding } from "@orkbot/core";
import { validateComposerMentionBindings } from "@orkbot/core";
import { Directory, File, Paths } from "expo-file-system";
import { currentApiBase } from "./api";
import { currentArtifactCacheSession } from "./artifact-cache-session";
import { hasManagedWorkspace, workspaceDraftOwner } from "./workspace-draft-session";

/** One unsent composer text per server, account, and conversation. */
export type ComposerDraftScope = Readonly<{
  apiBase: string;
  userId: string;
  threadKey: string;
  namespace: string;
  workspaceOwner?: string;
}>;

export type ComposerDraft = { text: string; bindings: ComposerMentionBinding[] };

/** Uses the web draft key (`bot:<id>` or `group:<id>`) inside the server and account. */
export function composerDraftScope(
  userId: string,
  botId: string | undefined,
  groupId: string | undefined,
): ComposerDraftScope | undefined {
  if (!userId || (!botId && !groupId)) return undefined;
  try {
    const namespace = currentArtifactCacheSession();
    if (!namespace) return undefined;
    const workspaceOwner = workspaceDraftOwner(currentApiBase(), userId);
    if (hasManagedWorkspace(currentApiBase()) && !workspaceOwner) return undefined;
    return {
      apiBase: currentApiBase(),
      userId,
      threadKey: groupId ? `group:${groupId}` : `bot:${botId}`,
      namespace,
      ...(workspaceOwner ? { workspaceOwner } : {}),
    };
  } catch {
    return undefined;
  }
}

export function isComposerDraftScopeCurrent(scope: ComposerDraftScope): boolean {
  try {
    return (
      (!hasManagedWorkspace(scope.apiBase) || !!scope.workspaceOwner) &&
      scope.namespace === currentArtifactCacheSession() &&
      scope.apiBase === currentApiBase() &&
      scope.workspaceOwner === workspaceDraftOwner(scope.apiBase, scope.userId)
    );
  } catch {
    return false;
  }
}

export function composerDraftScopeKey(scope: ComposerDraftScope): string {
  return JSON.stringify([
    scope.apiBase,
    scope.userId,
    scope.threadKey,
    scope.namespace,
    scope.workspaceOwner,
  ]);
}

// The OS may evict the cache when storage runs low, so an unsent draft lives next to
// the outbox in documents, like a message waiting to be sent.
function root() {
  return new Directory(Paths.document, "composer-drafts-v1");
}
/** Where earlier builds kept drafts. */
function legacyRoot() {
  return new Directory(Paths.cache, "composer-drafts-v1");
}
/** Exists while the earlier drafts are still in the cache but must not be copied again. */
function legacyDone() {
  return new File(Paths.document, "composer-drafts-legacy-done");
}

/** Explicit retirement removes both generations; stale callbacks still fail the namespace fence. */
export function clearComposerDrafts(includeManaged = true): void {
  if (includeManaged) deleteLeftover(new Directory(Paths.document, "composer-workspace-drafts-v2"));
  deleteLeftover(root());
  deleteLeftover(legacyRoot());
}
export function draftFolder(scope: ComposerDraftScope): Directory {
  return new Directory(
    scope.workspaceOwner
      ? new Directory(Paths.document, "composer-workspace-drafts-v2", scope.workspaceOwner)
      : root(),
    encodeURIComponent(scope.apiBase),
    `user-${encodeURIComponent(scope.userId)}`,
  );
}

function draftName(scope: ComposerDraftScope): string {
  return `${encodeURIComponent(scope.threadKey)}.json`;
}

function draftFile(scope: ComposerDraftScope): File {
  return new File(draftFolder(scope), draftName(scope));
}

// The next draft is written here first. Native replacement deletes the saved file before
// moving this one in, so after an interrupted move this file holds the newest draft.
function nextDraftFile(scope: ComposerDraftScope): File {
  return new File(draftFolder(scope), `${draftName(scope)}.tmp`);
}

function legacyDraftFile(scope: ComposerDraftScope, suffix: string): File {
  return new File(
    new Directory(
      legacyRoot(),
      encodeURIComponent(scope.apiBase),
      `user-${encodeURIComponent(scope.userId)}`,
    ),
    `${draftName(scope)}${suffix}`,
  );
}

function readDraftRecord(file: File): ComposerDraft | undefined {
  if (!file.exists) return undefined;
  try {
    const record = JSON.parse(file.textSync());
    if (record?.version !== 1 || typeof record.text !== "string") return undefined;
    return {
      text: record.text,
      bindings: validateComposerMentionBindings(record.text, record.bindings),
    };
  } catch {
    return undefined;
  }
}

/** Leftovers are retried on the next draft read or write; a failed delete must not block them. */
function deleteLeftover(entry: File | Directory): void {
  try {
    entry.delete();
  } catch {}
}

// Android can move a directory by copying and stop halfway, so copy the earlier cache
// drafts instead, keeping the source until a marker records a full copy (as the outbox
// does). The marker is written before any draft on a clean launch too, and stays forever:
// a cache copy that reappears later, after a downgrade, is never trusted over drafts
// saved since.
function migrateLegacyDrafts(): void {
  if (!legacyRoot().exists) {
    if (!legacyDone().exists) {
      legacyDone().create();
      // iOS can fail to create a file without an error; without the marker, a cache copy a
      // downgrade later leaves behind would replace drafts saved in the meantime.
      if (!legacyDone().exists) throw new Error("DRAFT_STORAGE_UNAVAILABLE");
    }
    return;
  }
  if (!legacyDone().exists) {
    copyVerifiedDrafts(legacyRoot(), root());
    legacyDone().create();
    // iOS can fail to create a file without an error; the source must stay until the marker exists.
    if (!legacyDone().exists) throw new Error("DRAFT_STORAGE_UNAVAILABLE");
  }
  deleteLeftover(legacyRoot());
}

/** Never remove a complete source until every file has an identical destination. */
function copyVerifiedDrafts(source: Directory, target: Directory): void {
  target.create({ intermediates: true, idempotent: true });
  for (const entry of source.list()) {
    if (!(entry instanceof File)) {
      copyVerifiedDrafts(entry, new Directory(target, entry.name));
      continue;
    }
    let destination = new File(target, entry.name);
    // Preserve a newer destination and retain the identical legacy bytes alongside it.
    if (destination.exists && destination.base64Sync() !== entry.base64Sync())
      destination = new File(target, `${entry.name}.legacy`);
    if (!destination.exists) {
      const temporary = new File(target, `${entry.name}.migrating`);
      if (temporary.exists) temporary.delete();
      entry.copySync(temporary);
      if (!temporary.exists || temporary.base64Sync() !== entry.base64Sync())
        throw new Error("DRAFT_STORAGE_UNAVAILABLE");
      temporary.moveSync(destination, { overwrite: true });
    }
    if (!destination.exists || destination.base64Sync() !== entry.base64Sync())
      throw new Error("DRAFT_STORAGE_UNAVAILABLE");
  }
}

// Moves a draft recovered from an interrupted move back to the saved name, so the next save
// writes a fresh next file instead of truncating the only copy. Throws when the move fails.
function promoteRecoveredDraft(scope: ComposerDraftScope): void {
  const next = nextDraftFile(scope);
  if (!readDraftRecord(draftFile(scope)) && readDraftRecord(next)) {
    next.moveSync(draftFile(scope), { overwrite: true });
  }
}

/** The draft as the earlier build saved it, read while its copy cannot move over. */
function readLegacyDraft(scope: ComposerDraftScope): ComposerDraft {
  try {
    return (
      readDraftRecord(legacyDraftFile(scope, "")) ??
      readDraftRecord(legacyDraftFile(scope, ".tmp")) ?? { text: "", bindings: [] }
    );
  } catch {
    return { text: "", bindings: [] };
  }
}

/** Same record as the web binding record; bindings that no longer match the text are dropped. */
export function readComposerDraft(scope: ComposerDraftScope | undefined): ComposerDraft {
  if (!scope || !isComposerDraftScopeCurrent(scope)) return { text: "", bindings: [] };
  try {
    if (!scope.workspaceOwner) migrateLegacyDrafts();
  } catch {
    // The copy retries on the next read or write. Until it works, the draft still lives
    // where the earlier build left it; reading it there keeps the composer from starting
    // empty and saving that emptiness over the draft.
    return (
      readDraftRecord(draftFile(scope)) ??
      readDraftRecord(nextDraftFile(scope)) ??
      readLegacyDraft(scope)
    );
  }
  try {
    try {
      promoteRecoveredDraft(scope);
    } catch {
      // Still readable from the next file; the next save retries the move first.
    }
    return (
      readDraftRecord(draftFile(scope)) ??
      readDraftRecord(nextDraftFile(scope)) ?? { text: "", bindings: [] }
    );
  } catch {
    // Evicted, corrupt, or unavailable storage starts an empty composer.
    return { text: "", bindings: [] };
  }
}

/** An empty text deletes the draft, so a sent message leaves nothing behind. False when it failed. */
export function writeComposerDraft(
  scope: ComposerDraftScope,
  text: string,
  bindings: readonly ComposerMentionBinding[],
): boolean {
  try {
    if (!isComposerDraftScopeCurrent(scope)) return false;
    if (!scope.workspaceOwner) migrateLegacyDrafts();
    const file = draftFile(scope);
    const next = nextDraftFile(scope);
    if (!text) {
      if (file.exists) file.delete();
      if (next.exists) next.delete();
      return true;
    }
    draftFolder(scope).create({ intermediates: true, idempotent: true });
    promoteRecoveredDraft(scope);
    // Replace the saved draft only once the new one is fully written.
    next.create({ overwrite: true });
    next.write(JSON.stringify({ version: 1, text, bindings }));
    next.moveSync(file, { overwrite: true });
    return true;
  } catch {
    // The draft still lives in the composer.
    return false;
  }
}
