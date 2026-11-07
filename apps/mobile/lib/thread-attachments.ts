// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 pickers are preserved. Draft attachment ownership follows LICENSE.md.

import type { MenuAction } from "@expo/ui/community/menu";
import { attachmentMaxBytes, attachmentMaxCount } from "@orkbot/contracts";
import type { RefObject, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import type { ThreadComposerHandle } from "../components/thread-composer";
import type { ComposerDraftScope } from "./composer-draft";
import { composerDraftScopeKey, isComposerDraftScopeCurrent } from "./composer-draft";
import {
  pickedAttachmentBytes,
  pinComposerDraft,
  readComposerDraftAttachments,
  writeComposerDraftAttachments,
} from "./composer-draft-attachments";
import { t, useI18n } from "./i18n";
import {
  getIncomingShare,
  isIncomingShareCurrent,
  retainIncomingShareFiles,
  retryIncomingShare,
  subscribeIncomingShare,
  takeIncomingShare,
} from "./incoming-share";
import type { PickedAttachment } from "./pick-attachments";
import {
  pickDocuments,
  pickFromLibrary,
  readDroppedFiles,
  readSharedFiles,
  takePhoto,
} from "./pick-attachments";
import { attachmentCountSkipReason, attachmentSizeSkipReason } from "./pick-attachments-filter";
import { useFileDrop } from "./use-file-drop";
import { errorText } from "./user-error";

export type PendingAttachment = PickedAttachment & {
  threadKey: string;
  draftScope?: ComposerDraftScope;
};

function formatAttachmentSkip(item: { name: string; reason: string }): string {
  const name = item.name === "camera" ? t("Camera") : item.name;
  if (item.reason === "permission denied") return t("{name} (permission denied)", { name });
  if (item.reason.startsWith("over "))
    return t("{name} (over {limit})", { name, limit: item.reason.slice(5) });
  if (item.reason === "unsupported type") return t("{name} (unsupported type)", { name });
  const maxMatch = /^max (\d+) attachments$/.exec(item.reason);
  if (maxMatch) {
    return t("{name} (max {count} attachments)", { name, count: maxMatch[1] ?? "" });
  }
  return `${name} (${t(item.reason)})`;
}

/** The composer's draft attachments, kept per chat, from the picker menu or a file drop. */
export function useThreadAttachments({
  botId,
  groupId,
  readOnly,
  uploadConfig,
  draftScope,
}: {
  botId?: string;
  groupId?: string;
  readOnly: boolean;
  draftScope?: ComposerDraftScope;
  uploadConfig?: { maxUploadSizeBytes?: number; maxAttachmentsPerMessage?: number };
}) {
  const { t } = useI18n();
  const threadKey = groupId ?? botId;
  const [pendingAttachments, updatePendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const pendingAttachmentsRef = useRef(pendingAttachments);
  const limitsRef = useRef(uploadConfig);
  limitsRef.current = uploadConfig;
  const source = useRef(draftScope);
  source.current = draftScope;
  const held = useRef(new Map<symbol, { scope: ComposerDraftScope; items: PickedAttachment[] }>());
  const ownerKey = draftScope && composerDraftScopeKey(draftScope);
  const owned = (item: PendingAttachment, scope: ComposerDraftScope) =>
    item.draftScope && composerDraftScopeKey(item.draftScope) === composerDraftScopeKey(scope);
  const activePendingAttachments = draftScope
    ? pendingAttachments.filter((item) => owned(item, draftScope))
    : [];

  function persist(scope: ComposerDraftScope, items: PendingAttachment[]): boolean {
    const retained = [
      ...items.filter((item) => owned(item, scope)),
      ...[...held.current.values()]
        .filter((entry) => composerDraftScopeKey(entry.scope) === composerDraftScopeKey(scope))
        .flatMap((entry) => entry.items),
    ];
    return writeComposerDraftAttachments(scope, [
      ...new Map(retained.map((item) => [item.id, item])).values(),
    ]);
  }
  function setPendingAttachments(change: SetStateAction<PendingAttachment[]>) {
    const previous = pendingAttachmentsRef.current;
    const next = (typeof change === "function" ? change(previous) : change).map((item) =>
      item.draftScope || !source.current ? item : { ...item, draftScope: source.current },
    );
    const owners = new Map(
      [...previous, ...next].flatMap((item) =>
        item.draftScope ? [[composerDraftScopeKey(item.draftScope), item.draftScope] as const] : [],
      ),
    );
    for (const scope of owners.values())
      if (isComposerDraftScopeCurrent(scope) && !persist(scope, next)) {
        setAttachmentNotice(t("Could not attach files"));
        return;
      }
    pendingAttachmentsRef.current = next;
    updatePendingAttachments(next);
  }
  useEffect(() => {
    if (!draftScope || !isComposerDraftScopeCurrent(draftScope)) return;
    const release = pinComposerDraft(draftScope);
    const restored = readComposerDraftAttachments(draftScope).map((item) => ({
      ...item,
      threadKey: threadKey!,
      draftScope,
    }));
    const next = [
      ...pendingAttachmentsRef.current.filter((item) => !owned(item, draftScope)),
      ...restored,
    ];
    pendingAttachmentsRef.current = next;
    updatePendingAttachments(next);
    setAttachmentNotice(null);
    return release;
  }, [ownerKey]);

  function captureForSend(ids: readonly string[]) {
    const scope = source.current;
    if (!scope || !isComposerDraftScopeCurrent(scope)) return () => undefined;
    const captured = pendingAttachmentsRef.current
      .filter((item) => owned(item, scope) && ids.includes(item.id))
      .map((item) => ({ ...item }));
    if (!captured.length) return () => undefined;
    const release = pinComposerDraft(scope);
    const key = Symbol();
    held.current.set(key, { scope, items: captured });
    let settled = false;
    return () => {
      if (settled) return;
      held.current.delete(key);
      if (isComposerDraftScopeCurrent(scope) && !persist(scope, pendingAttachmentsRef.current)) {
        held.current.set(key, { scope, items: captured });
        release();
        return;
      }
      settled = true;
      release();
    };
  }

  function admit(
    scope: ComposerDraftScope,
    candidates: PickedAttachment[],
    maxBytes: number,
    maxCount: number,
  ) {
    if (!isComposerDraftScopeCurrent(scope)) return { accepted: [], rejected: candidates };
    const heldIds = new Set(
      [...held.current.values()]
        .filter((entry) => composerDraftScopeKey(entry.scope) === composerDraftScopeKey(scope))
        .flatMap((entry) => entry.items.map((item) => item.id)),
    );
    const existing = [
      ...new Map(
        [
          ...readComposerDraftAttachments(scope).filter((item) => !heldIds.has(item.id)),
          ...pendingAttachmentsRef.current.filter((item) => owned(item, scope)),
        ].map((item) => [item.id, item]),
      ).values(),
    ];
    const accepted: PickedAttachment[] = [];
    const rejected: PickedAttachment[] = [];
    const ids = new Set(existing.map((item) => item.id));
    for (const item of candidates) {
      if (ids.has(item.id)) continue;
      if (existing.length + accepted.length >= maxCount || pickedAttachmentBytes(item) > maxBytes)
        rejected.push(item);
      else {
        accepted.push(item);
        ids.add(item.id);
      }
    }
    const next = [
      ...pendingAttachmentsRef.current.filter((item) => !owned(item, scope)),
      ...[...existing, ...accepted].map((item) => ({
        ...item,
        threadKey: scope.threadKey.slice(scope.threadKey.indexOf(":") + 1),
        draftScope: scope,
      })),
    ];
    if (!persist(scope, next)) return { accepted: [], rejected: candidates, storageFailed: true };
    pendingAttachmentsRef.current = next;
    updatePendingAttachments(next);
    return { accepted, rejected };
  }
  const importingShare = useRef(false);
  const [shareImporting, setShareImporting] = useState(false);

  const attachActions: MenuAction[] = [
    { id: "library", title: t("Photo library"), image: "photo.on.rectangle" },
    { id: "camera", title: t("Camera"), image: "camera" },
    { id: "file", title: t("File"), image: "doc" },
  ];

  function attachFrom(source: string) {
    if (importingShare.current) return;
    if (source === "library") void addAttachments(pickFromLibrary);
    else if (source === "camera") void addAttachments(takePhoto);
    else if (source === "file") void addAttachments(pickDocuments);
  }

  async function addAttachments(
    picker: (
      existingCount: number,
      maxBytes: number,
      maxCount: number,
    ) => Promise<{
      attachments: PickedAttachment[];
      skipped: Array<{ name: string; reason: string }>;
    }>,
  ) {
    const target = draftScope;
    if (!target || !isComposerDraftScopeCurrent(target)) return;
    let result: Awaited<ReturnType<typeof picker>>;
    try {
      result = await picker(
        activePendingAttachments.length,
        attachmentMaxBytes(uploadConfig),
        attachmentMaxCount(uploadConfig),
      );
    } catch (error) {
      // A picker that fails to open reports it instead of rejecting unhandled.
      setAttachmentNotice(errorText(error, t("Could not attach files")));
      return;
    }
    const { rejected, storageFailed } = admit(
      target,
      result.attachments,
      attachmentMaxBytes(limitsRef.current),
      attachmentMaxCount(limitsRef.current),
    );
    if (!source.current || composerDraftScopeKey(source.current) !== composerDraftScopeKey(target))
      return;
    if (storageFailed) {
      setAttachmentNotice(t("Could not attach files"));
      return;
    }
    const skipped = [
      ...result.skipped,
      ...rejected.map((attachment) => ({
        name: attachment.name,
        reason:
          pickedAttachmentBytes(attachment) > attachmentMaxBytes(limitsRef.current)
            ? attachmentSizeSkipReason(attachmentMaxBytes(limitsRef.current))
            : attachmentCountSkipReason(attachmentMaxCount(limitsRef.current)),
      })),
    ];
    setAttachmentNotice(
      skipped.length
        ? t("Skipped {items}", {
            items: skipped.map((item) => formatAttachmentSkip(item)).join(", "),
          })
        : null,
    );
  }

  useFileDrop(
    ownerKey ?? null,
    ({ files, skipped }) => {
      void addAttachments((count, maxBytes, maxCount) =>
        readDroppedFiles(files, count, maxBytes, skipped, maxCount),
      );
    },
    {
      enabled: !readOnly && Boolean(ownerKey),
      maxBytes: attachmentMaxBytes(uploadConfig),
      maxFiles: attachmentMaxCount(uploadConfig),
    },
  );

  return {
    pendingAttachments: activePendingAttachments,
    setPendingAttachments,
    admit,
    captureForSend,
    draftScope,
    activePendingAttachments,
    attachmentNotice,
    setAttachmentNotice,
    attachActions,
    attachFrom,
    importingShare,
    shareImporting,
    setShareImporting,
  };
}

/** Takes an incoming share into this chat once its upload limits are known. */
export function useIncomingShareImport({
  attachments,
  composerRef,
  readOnly,
  threadKey,
  uploadConfig,
}: {
  attachments: ReturnType<typeof useThreadAttachments>;
  composerRef: RefObject<ThreadComposerHandle | null>;
  readOnly: boolean;
  threadKey: string | undefined;
  uploadConfig?: { maxUploadSizeBytes?: number; maxAttachmentsPerMessage?: number };
}) {
  const { importingShare, setShareImporting, setAttachmentNotice, draftScope } = attachments;
  const [retryTick, setRetryTick] = useState(0);
  const ownerKey = draftScope && composerDraftScopeKey(draftScope);
  const seenGeneration = useRef<number | undefined>(undefined);
  useEffect(
    () =>
      subscribeIncomingShare(() => {
        const queued = getIncomingShare();
        if (queued && queued.generation !== seenGeneration.current)
          setRetryTick((tick) => tick + 1);
      }),
    [],
  );
  useEffect(() => {
    if (!threadKey || !draftScope || readOnly || !uploadConfig || importingShare.current) return;
    const share = takeIncomingShare(composerDraftScopeKey(draftScope));
    if (!share) return;
    seenGeneration.current = share.generation;
    let active = true;
    const release = retainIncomingShareFiles(share.files);
    const unpin = pinComposerDraft(draftScope);
    importingShare.current = true;
    setShareImporting(true);
    void (async () => {
      try {
        const result = await readSharedFiles(
          share.files,
          attachments.activePendingAttachments.length,
          attachmentMaxBytes(uploadConfig),
          attachmentMaxCount(uploadConfig),
        );
        if (!active || !isIncomingShareCurrent(share) || !isComposerDraftScopeCurrent(draftScope)) {
          return;
        }
        const admitted = attachments.admit(
          draftScope,
          result.attachments,
          attachmentMaxBytes(uploadConfig),
          attachmentMaxCount(uploadConfig),
        );
        if (admitted.storageFailed) {
          retryIncomingShare(share);
          setAttachmentNotice(t("Could not attach files"));
          return;
        }
        if (result.failedFiles.length)
          retryIncomingShare({ ...share, text: "", files: result.failedFiles });
        const skipped = [
          ...result.skipped,
          ...admitted.rejected.map((item) => ({
            name: item.name,
            reason: attachmentCountSkipReason(attachmentMaxCount(uploadConfig)),
          })),
        ];
        setAttachmentNotice(
          skipped.length
            ? t("Skipped {items}", {
                items: skipped.map((item) => formatAttachmentSkip(item)).join(", "),
              })
            : null,
        );
        if (share.text) composerRef.current?.insert(share.text);
      } catch {
        if (isComposerDraftScopeCurrent(draftScope)) retryIncomingShare(share);
        if (active) setAttachmentNotice(t("Could not attach files"));
      } finally {
        importingShare.current = false;
        setShareImporting(false);
        // Retry publication follows the old reader's release so a newly mounted source can claim it.
        if (!active && isComposerDraftScopeCurrent(draftScope)) {
          retryIncomingShare(share);
          setRetryTick((tick) => tick + 1);
        }
        release();
        unpin();
      }
    })();
    return () => {
      active = false;
    };
  }, [ownerKey, threadKey, readOnly, uploadConfig, retryTick]);
}
