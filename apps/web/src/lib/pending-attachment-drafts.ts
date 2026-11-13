// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { ATTACHMENT_COUNT_CEILING } from "@orkbot/contracts";

type Attachment = { id: string; threadKey: string; file: File };
type StoredAttachment = Omit<Attachment, "file"> & {
  blob: Blob;
  name: string;
  lastModified: number;
};
type Record = { version: 1; updatedAt: number; attachments: StoredAttachment[] };
export const DRAFT_ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024;
export const DRAFT_ATTACHMENT_MAX_CHATS = 20;
export const DRAFT_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DATABASE = "orkbot-composer-attachments-v1";
const STORE = "drafts";
const pins = new Map<string, number>();
let database: Promise<IDBDatabase | null> | undefined;
let writes: Promise<unknown> = Promise.resolve();

function open(): Promise<IDBDatabase | null> {
  database ??= new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return database;
}
function enqueue(operation: () => Promise<void>): Promise<void> {
  const next = writes.then(operation, operation);
  writes = next.catch(() => undefined);
  return next;
}
function valid(record: unknown): record is Record {
  if (!record || typeof record !== "object") return false;
  const value = record as Record;
  return (
    value.version === 1 &&
    Number.isFinite(value.updatedAt) &&
    Array.isArray(value.attachments) &&
    value.attachments.length <= DRAFT_ATTACHMENT_MAX_CHATS * ATTACHMENT_COUNT_CEILING &&
    value.attachments.every(
      (item) =>
        item &&
        typeof item.id === "string" &&
        item.id.length > 0 &&
        item.id.length <= 255 &&
        typeof item.threadKey === "string" &&
        item.threadKey.length > 0 &&
        item.threadKey.length <= 255 &&
        typeof item.name === "string" &&
        item.name.length <= 255 &&
        item.blob instanceof Blob &&
        item.blob.size <= DRAFT_ATTACHMENT_MAX_BYTES &&
        Number.isFinite(item.lastModified),
    )
  );
}
function withinBudget(records: Array<{ scope: string; record: Record }>): boolean {
  let bytes = 0;
  const chats = new Map<string, number>();
  for (const { scope, record } of records) {
    const ids = new Set<string>();
    for (const item of record.attachments) {
      if (ids.has(item.id)) return false;
      ids.add(item.id);
      bytes += item.blob.size;
      const key = JSON.stringify([scope, item.threadKey]);
      const count = (chats.get(key) ?? 0) + 1;
      chats.set(key, count);
      if (
        bytes > DRAFT_ATTACHMENT_MAX_BYTES ||
        chats.size > DRAFT_ATTACHMENT_MAX_CHATS ||
        count > ATTACHMENT_COUNT_CEILING
      )
        return false;
    }
  }
  return true;
}
export function pinPendingAttachmentDrafts(scope: string): () => void {
  pins.set(scope, (pins.get(scope) ?? 0) + 1);
  return () => {
    const count = (pins.get(scope) ?? 1) - 1;
    if (count) pins.set(scope, count);
    else pins.delete(scope);
  };
}

/** Native profiles isolate installations/accounts; the key additionally isolates each space. */
export async function readPendingAttachmentDrafts(scope: string): Promise<Attachment[]> {
  await writes;
  const db = await open();
  if (!db) return [];
  const stored = await new Promise<unknown>((resolve) => {
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).get(scope);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
    transaction.onabort = () => resolve(undefined);
  });
  if (
    !valid(stored) ||
    Date.now() - stored.updatedAt >= DRAFT_ATTACHMENT_RETENTION_MS ||
    !withinBudget([{ scope, record: stored }])
  )
    return [];
  return stored.attachments.map((value) => ({
    id: value.id,
    threadKey: value.threadKey,
    file: new File([value.blob], value.name, {
      type: value.blob.type,
      lastModified: value.lastModified,
    }),
  }));
}

/** Reject excess storage atomically; never evict a fresh unsent conversation to admit another. */
export function writePendingAttachmentDrafts(
  scope: string,
  attachments: readonly Attachment[],
): Promise<void> {
  const next: Record = {
    version: 1,
    updatedAt: Date.now(),
    attachments: attachments.map(({ id, threadKey, file }) => ({
      id,
      threadKey,
      blob: file,
      name: file.name,
      lastModified: file.lastModified,
    })),
  };
  if (!valid(next) || !withinBudget([{ scope, record: next }]))
    return Promise.reject(new Error("Draft attachment storage is full"));
  return enqueue(async () => {
    const db = await open();
    if (!db) {
      if (attachments.length) throw new Error("Draft attachment storage is unavailable");
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const records = [{ scope, record: next }];
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) {
          if (!withinBudget(records)) {
            transaction.abort();
            return;
          }
          if (next.attachments.length) store.put(next, scope);
          else store.delete(scope);
          return;
        }
        if (current.key !== scope) {
          if (!valid(current.value)) {
            transaction.abort();
            return;
          }
          if (
            Date.now() - current.value.updatedAt >= DRAFT_ATTACHMENT_RETENTION_MS &&
            !pins.has(String(current.key))
          )
            current.delete();
          else records.push({ scope: String(current.key), record: current.value });
        }
        current.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error("Could not save draft attachments"));
      transaction.onerror = () => reject(new Error("Could not save draft attachments"));
    });
  });
}

/** Old callbacks retain their retired nonce and cannot write into a later login. */
export function clearPendingAttachmentDrafts(namespace: string): Promise<void> {
  return enqueue(async () => {
    const db = await open();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const cursor = transaction.objectStore(STORE).openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        try {
          if (typeof current.key === "string" && JSON.parse(current.key)[0] === namespace)
            current.delete();
        } catch {
          /* Unrelated keys do not belong to this login. */
        }
        current.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error("Could not clear attachments"));
      transaction.onerror = () => reject(new Error("Could not clear attachments"));
    });
  });
}
