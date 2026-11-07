// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_COUNT_CEILING,
  ATTACHMENT_MAX_BYTES,
} from "@orkbot/contracts";
import { Directory, File, Paths } from "expo-file-system";
import type { ComposerDraftScope } from "./composer-draft";
import { isComposerDraftScopeCurrent } from "./composer-draft";
import type { PickedAttachment } from "./pick-attachments";

export const DRAFT_ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024;
export const DRAFT_ATTACHMENT_MAX_CHATS = 20;
export const DRAFT_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const pins = new Map<string, number>();
function root() {
  return new Directory(Paths.document, "composer-attachments-v1");
}
function folder(scope: ComposerDraftScope) {
  return new Directory(
    root(),
    encodeURIComponent(scope.namespace),
    encodeURIComponent(scope.apiBase),
    encodeURIComponent(scope.userId),
  );
}
function file(scope: ComposerDraftScope, suffix = "") {
  return new File(folder(scope), `${encodeURIComponent(scope.threadKey)}.json${suffix}`);
}
function walk(directory: Directory): File[] {
  return directory.exists
    ? directory.list().flatMap((entry) => (entry instanceof File ? [entry] : walk(entry)))
    : [];
}

/** Active editors and asynchronous readers keep their exact source out of expiry reclamation. */
export function pinComposerDraft(scope: ComposerDraftScope): () => void {
  const key = file(scope).uri;
  pins.set(key, (pins.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (pins.get(key) ?? 1) - 1;
    if (count) pins.set(key, count);
    else pins.delete(key);
  };
}

export function pickedAttachmentBytes(attachment: PickedAttachment): number {
  const value = attachment.contentBase64;
  return (
    Math.floor((value.length * 3) / 4) - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0)
  );
}

function valid(value: unknown): value is PickedAttachment {
  if (!value || typeof value !== "object") return false;
  const item = value as PickedAttachment;
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    item.id.length <= 255 &&
    typeof item.name === "string" &&
    item.name.length <= 255 &&
    (ATTACHMENT_ALLOWED_MIME_TYPES as readonly string[]).includes(item.mimeType) &&
    typeof item.contentBase64 === "string" &&
    item.contentBase64.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(item.contentBase64) &&
    item.contentBase64.length <= Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4 &&
    pickedAttachmentBytes(item) <= ATTACHMENT_MAX_BYTES
  );
}

function record(source: File) {
  try {
    if (!source.exists || !Number.isFinite(source.size) || source.size > DRAFT_ATTACHMENT_MAX_BYTES)
      return undefined;
    const parsed = JSON.parse(source.textSync());
    return parsed?.version === 1 &&
      typeof parsed.updatedAt === "number" &&
      Array.isArray(parsed.attachments) &&
      parsed.attachments.length <= ATTACHMENT_COUNT_CEILING &&
      parsed.attachments.every(valid)
      ? (parsed as { version: 1; updatedAt: number; attachments: PickedAttachment[] })
      : undefined;
  } catch {
    return undefined;
  }
}

export function readComposerDraftAttachments(
  scope: ComposerDraftScope | undefined,
): PickedAttachment[] {
  if (!scope || !isComposerDraftScopeCurrent(scope)) return [];
  try {
    const saved = record(file(scope)) ?? record(file(scope, ".bak"));
    if (!saved || Date.now() - saved.updatedAt >= DRAFT_ATTACHMENT_RETENTION_MS) return [];
    return saved.attachments.map((item) => ({
      ...item,
      previewUri: item.mimeType.startsWith("image/")
        ? `data:${item.mimeType};base64,${item.contentBase64}`
        : undefined,
    }));
  } catch {
    return [];
  }
}

/** Admission is bounded without evicting an editor or another unsent conversation to make room. */
export function writeComposerDraftAttachments(
  scope: ComposerDraftScope,
  attachments: readonly PickedAttachment[],
): boolean {
  if (
    !isComposerDraftScopeCurrent(scope) ||
    attachments.length > ATTACHMENT_COUNT_CEILING ||
    !attachments.every(valid) ||
    new Set(attachments.map((item) => item.id)).size !== attachments.length
  )
    return false;
  try {
    const target = file(scope);
    const temporary = file(scope, ".tmp");
    const backup = file(scope, ".bak");
    if (!attachments.length) {
      for (const entry of [temporary, backup, target]) {
        try {
          if (entry.exists) entry.delete();
        } catch {
          /* A verified empty record retires unreadable leftovers. */
        }
      }
      if (!target.exists && !temporary.exists && !backup.exists) return true;
    }

    const entries = walk(root());
    for (const entry of entries) {
      if (
        entry.uri === target.uri ||
        (pins.has(entry.uri.replace(/\.(tmp|bak)$/, "")) &&
          entry.uri.startsWith(
            `${new Directory(root(), encodeURIComponent(scope.namespace)).uri.replace(/\/$/, "")}/`,
          ))
      )
        continue;
      const saved = record(entry);
      const updatedAt =
        saved?.updatedAt ?? (entry.name.endsWith(".tmp") ? entry.modificationTime : undefined);
      if (
        typeof updatedAt === "number" &&
        Number.isFinite(updatedAt) &&
        Date.now() - updatedAt >= DRAFT_ATTACHMENT_RETENTION_MS
      )
        entry.delete();
    }
    const retained = walk(root()).filter(
      (entry) =>
        entry.uri !== target.uri && entry.uri !== temporary.uri && entry.uri !== backup.uri,
    );
    const payload = JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      attachments: attachments.map(({ id, name, mimeType, contentBase64 }) => ({
        id,
        name,
        mimeType,
        contentBase64,
      })),
    });
    if (
      retained.filter((entry) => !entry.name.endsWith(".tmp") && !entry.name.endsWith(".bak"))
        .length >= DRAFT_ATTACHMENT_MAX_CHATS ||
      retained.reduce(
        (sum, entry) => sum + (Number.isFinite(entry.size) ? entry.size : Number.POSITIVE_INFINITY),
        0,
      ) +
        new TextEncoder().encode(payload).length >
        DRAFT_ATTACHMENT_MAX_BYTES
    )
      return false;
    folder(scope).create({ intermediates: true, idempotent: true });
    temporary.create({ overwrite: true });
    temporary.write(payload);
    if (!temporary.exists || temporary.textSync() !== payload) return false;
    if (record(target)) {
      const previous = target.textSync();
      target.copySync(backup, { overwrite: true });
      if (!backup.exists || backup.textSync() !== previous) return false;
    }
    try {
      temporary.moveSync(target, { overwrite: true });
      if (!target.exists || target.textSync() !== payload)
        throw new Error("DRAFT_STORAGE_UNAVAILABLE");
    } catch {
      if (target.exists) target.delete();
      return false;
    }
    try {
      if (backup.exists) backup.delete();
    } catch {
      /* The verified canonical record remains authoritative. */
    }
    return true;
  } catch {
    return false;
  }
}

export function clearComposerDraftAttachments(): void {
  try {
    if (root().exists) root().delete();
  } catch {
    /* A new login namespace cannot read a leftover source. */
  }
}
