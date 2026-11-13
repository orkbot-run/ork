// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 material is preserved; source-owned composer recovery is an Ork addition.

import type { ComposerMentionBinding } from "@orkbot/core";
import {
  mergeComposerDraftContent,
  newClientId,
  validateComposerMentionBindings,
} from "@orkbot/core";
import { clearPendingAttachmentDrafts } from "./pending-attachment-drafts";

export const COMPOSER_DRAFT_STORAGE_PREFIX = "orkbot.runposerDraft.";
const COMPOSER_BINDINGS_STORAGE_PREFIX = "orkbot.runposerBindings.";
const COMPOSER_NAMESPACE_STORAGE_KEY = "orkbot.composerDraftNamespace";

export type ComposerDraftSource = {
  readonly threadKey: string;
  readonly namespace: string | null;
  readonly lifetime: object;
  readonly origin: string;
};
type DraftContent = { text: string; bindings: ComposerMentionBinding[] };
type ComposerDraftSubmission = {
  source: ComposerDraftSource;
  content: DraftContent;
  recovery: DraftContent;
  revision: number;
  bindingRecord: string | null;
};
let lifetime = {};
const draftRevisions = new Map<string, number>();
const pendingSubmissions = new Set<ComposerDraftSubmission>();
const draftListeners = new Map<string, Set<(draft: DraftContent) => void>>();

/** A login's source survives chat navigation and token rotation, but never an explicit wipe. */
export function captureComposerDraftSource(threadKey: string): ComposerDraftSource {
  let namespace: string | null = null;
  try {
    const storage = getLocalStorage();
    namespace = storage?.getItem(COMPOSER_NAMESPACE_STORAGE_KEY) ?? null;
    if (storage && !namespace) {
      namespace = newClientId();
      storage.setItem(COMPOSER_NAMESPACE_STORAGE_KEY, namespace);
    }
  } catch {
    namespace = null;
    /* A missing durable namespace fails closed for asynchronous writes. */
  }
  return {
    threadKey,
    namespace,
    lifetime,
    origin: typeof window === "undefined" ? "" : window.location.origin,
  };
}

/** Without durable ownership, recovery is limited to the same live composer instance. */
export function isComposerDraftMemorySourceCurrent(source: ComposerDraftSource): boolean {
  if (
    source.namespace !== null ||
    source.lifetime !== lifetime ||
    source.origin !== (typeof window === "undefined" ? "" : window.location.origin)
  )
    return false;
  try {
    return (getLocalStorage()?.getItem(COMPOSER_NAMESPACE_STORAGE_KEY) ?? null) === null;
  } catch {
    return false;
  }
}

export function isComposerDraftSourceCurrent(source: ComposerDraftSource): boolean {
  if (
    source.lifetime !== lifetime ||
    source.origin !== (typeof window === "undefined" ? "" : window.location.origin)
  )
    return false;
  try {
    const storage = getLocalStorage();
    return storage
      ? !!source.namespace && storage.getItem(COMPOSER_NAMESPACE_STORAGE_KEY) === source.namespace
      : source.namespace === null;
  } catch {
    return false;
  }
}

function publishDraft(threadKey: string, draft: DraftContent) {
  for (const listener of draftListeners.get(threadKey) ?? []) listener(draft);
}

export function appendComposerDraftText(source: ComposerDraftSource, text: string): void {
  if (!text || !isComposerDraftSourceCurrent(source)) return;
  let current = {
    text: readComposerDraft(source.threadKey),
    bindings: readComposerDraftBindings(source.threadKey),
  };
  // A submitted version stays on disk for recovery, but is no longer the editable draft.
  if (
    [...pendingSubmissions].some(
      (submission) =>
        submission.source.threadKey === source.threadKey &&
        submission.revision === draftRevisions.get(source.threadKey) &&
        submission.content.text === current.text &&
        submission.bindingRecord === readBindingRecord(source.threadKey),
    )
  )
    current = { text: "", bindings: [] };
  const next = mergeComposerDraftContent(current, { text, bindings: [] });
  writeComposerDraft(source.threadKey, next.text, undefined, next.bindings);
  publishDraft(source.threadKey, next);
}

export function beginComposerDraftSubmission(
  threadKey: string,
  text: string,
  recovery?: DraftContent,
): ComposerDraftSubmission {
  writeComposerDraft(threadKey, text);
  const submission = {
    source: captureComposerDraftSource(threadKey),
    content: { text, bindings: readComposerDraftBindings(threadKey) },
    recovery: recovery ?? { text, bindings: readComposerDraftBindings(threadKey) },
    revision: draftRevisions.get(threadKey) ?? 0,
    bindingRecord: readBindingRecord(threadKey),
  };
  pendingSubmissions.add(submission);
  return submission;
}

export function settleComposerDraftSubmission(
  threadKey: string,
  submission: ComposerDraftSubmission,
  accepted: boolean | undefined,
): void {
  if (
    !pendingSubmissions.delete(submission) ||
    threadKey !== submission.source.threadKey ||
    !isComposerDraftSourceCurrent(submission.source)
  )
    return;
  // An exceptional callback leaves acceptance unknown; it must not expose a new retry.
  if (accepted === undefined) return;
  const unchanged =
    draftRevisions.get(threadKey) === submission.revision &&
    readComposerDraft(threadKey) === submission.content.text &&
    readBindingRecord(threadKey) === submission.bindingRecord;
  if (accepted) {
    if (!unchanged) return;
    writeComposerDraft(threadKey, "");
    publishDraft(threadKey, { text: "", bindings: [] });
    return;
  }
  const next = unchanged
    ? submission.content
    : mergeComposerDraftContent(submission.recovery, {
        text: readComposerDraft(threadKey),
        bindings: readComposerDraftBindings(threadKey),
      });
  writeComposerDraft(threadKey, next.text, undefined, next.bindings);
  publishDraft(threadKey, next);
}

let sendingWork = false;
let attachmentWork = false;

/**
 * The shell reports work a reload would lose: a send (typed or spoken) until the server answers,
 * or picked attachments, which live only in memory.
 */
export function setComposerUnsavedWork(work: { sending: boolean; attachments: boolean }): void {
  sendingWork = work.sending;
  attachmentWork = work.attachments;
}

/** A send waiting for its answer, or attachments that only exist in memory. */
export function composerHoldsUnsavedWork(): boolean {
  return composerHoldsWorkInFlight() || attachmentWork;
}

/** A send waiting for its answer. Unlike picked attachments, it finishes on its own. */
export function composerHoldsWorkInFlight(): boolean {
  return pendingSubmissions.size > 0 || sendingWork;
}

/** Unsaved composer work, or saved text in any composer that has not been sent. */
export function hasUnsentComposerDraft(storage: Storage | null = null): boolean {
  if (composerHoldsUnsavedWork()) return true;
  try {
    const drafts = storage ?? localStorage;
    for (let index = 0; index < drafts.length; index++) {
      const key = drafts.key(index);
      if (key?.startsWith(COMPOSER_DRAFT_STORAGE_PREFIX) && drafts.getItem(key)) return true;
    }
  } catch {
    // Without storage the draft lives only in memory, so treat it as unsent.
    return true;
  }
  return false;
}

/** Signing out leaves no saved draft, or its mentions, for whoever uses this browser next. */
export function clearComposerDrafts(): void {
  lifetime = {};
  try {
    const storage = getLocalStorage();
    const retired = storage?.getItem(COMPOSER_NAMESPACE_STORAGE_KEY);
    if (retired) void clearPendingAttachmentDrafts(retired).catch(() => undefined);
    storage?.removeItem(COMPOSER_NAMESPACE_STORAGE_KEY);
    storage?.setItem(COMPOSER_NAMESPACE_STORAGE_KEY, newClientId());
  } catch {}
  pendingSubmissions.clear();
  draftRevisions.clear();
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    for (const key of keys) {
      if (
        key?.startsWith(COMPOSER_DRAFT_STORAGE_PREFIX) ||
        key?.startsWith(COMPOSER_BINDINGS_STORAGE_PREFIX)
      )
        localStorage.removeItem(key);
    }
  } catch {
    // Without storage no draft was saved.
  }
}

export function subscribeComposerDraft(
  threadKey: string,
  listener: (draft: DraftContent) => void,
): () => void {
  let listeners = draftListeners.get(threadKey);
  if (!listeners) {
    listeners = new Set();
    draftListeners.set(threadKey, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) draftListeners.delete(threadKey);
  };
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function getLocalStorage(): DraftStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function composerDraftStorageKey(threadKey: string): string {
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}${threadKey}`;
}

export function composerDraftBindingsKey(threadKey: string): string {
  return `${COMPOSER_BINDINGS_STORAGE_PREFIX}${threadKey}`;
}

function readBindingRecord(threadKey: string, storage = getLocalStorage()): string | null {
  try {
    return storage?.getItem(composerDraftBindingsKey(threadKey)) ?? null;
  } catch {
    return null;
  }
}

/** Bindings are optional metadata; a stale record must never replace the raw text. */
export function readComposerDraftBindings(
  threadKey: string,
  storage: DraftStorage | null = getLocalStorage(),
): ComposerMentionBinding[] {
  if (!storage || !threadKey) return [];
  const key = composerDraftBindingsKey(threadKey);
  try {
    const raw = readBindingRecord(threadKey, storage);
    if (!raw) return [];
    const record = JSON.parse(raw);
    const text = readComposerDraft(threadKey, storage);
    if (record?.version !== 1 || record.text !== text) {
      storage.removeItem(key);
      return [];
    }
    return validateComposerMentionBindings(text, record.bindings);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* The in-memory draft remains usable. */
    }
    return [];
  }
}

export function readComposerDraft(
  threadKey: string,
  storage: DraftStorage | null = getLocalStorage(),
): string {
  if (!storage || !threadKey) return "";
  try {
    return storage.getItem(composerDraftStorageKey(threadKey)) ?? "";
  } catch {
    return "";
  }
}

export function writeComposerDraft(
  threadKey: string,
  draft: string,
  storage: DraftStorage | null = getLocalStorage(),
  bindings?: readonly ComposerMentionBinding[],
): void {
  draftRevisions.set(threadKey, (draftRevisions.get(threadKey) ?? 0) + 1);
  if (!storage || !threadKey) return;
  try {
    // Plain-text callers preserve bindings only when they are resubmitting the
    // unchanged draft. New text without bindings cannot inherit old identities.
    if (bindings !== undefined || draft !== readComposerDraft(threadKey, storage) || !draft) {
      storage.removeItem(composerDraftBindingsKey(threadKey));
    }
    if (draft.length === 0) storage.removeItem(composerDraftStorageKey(threadKey));
    else storage.setItem(composerDraftStorageKey(threadKey), draft);
    if (bindings?.length && draft) {
      storage.setItem(
        composerDraftBindingsKey(threadKey),
        JSON.stringify({ version: 1, text: draft, bindings }),
      );
    }
  } catch {
    // Quota or private-mode failures: the draft still lives in memory.
  }
}
