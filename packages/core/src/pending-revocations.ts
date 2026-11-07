// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { isPrivateNetworkHost, parseServerHeaders } from "@orkbot/contracts";

export type PendingRevocation = {
  kind: "session" | "oauth";
  origin: string;
  token: string;
  createdAt: number;
  headers?: Record<string, string>;
  clientId?: string;
  tokenType?: "access_token" | "refresh_token";
};

export const REVOCATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_REVOCATIONS = 20;
export const MAX_REVOCATION_STORE_CHARS = 128 * 1024;

function valid(entry: PendingRevocation, now: number): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (entry.kind !== "session" && entry.kind !== "oauth") return false;
  if (
    typeof entry.token !== "string" ||
    !entry.token ||
    entry.token.length > 16 * 1024 ||
    /[\r\n]/.test(entry.token)
  )
    return false;
  if (
    !Number.isSafeInteger(entry.createdAt) ||
    entry.createdAt > now ||
    entry.createdAt <= now - REVOCATION_RETENTION_MS
  )
    return false;
  try {
    const url = new URL(entry.origin);
    if (
      (entry.kind === "session"
        ? url.origin !== entry.origin
        : url.protocol !== "https:" || Boolean(url.search || url.hash)) ||
      url.username ||
      url.password ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && isPrivateNetworkHost(url.hostname))
      )
    )
      return false;
  } catch {
    return false;
  }
  if (entry.kind === "oauth")
    return (
      typeof entry.clientId === "string" &&
      entry.clientId.length > 0 &&
      entry.clientId.length <= 1024 &&
      (entry.tokenType === "access_token" || entry.tokenType === "refresh_token")
    );
  return entry.headers === undefined || parseServerHeaders(entry.headers) !== null;
}

function same(first: PendingRevocation, second: PendingRevocation): boolean {
  return (
    first.kind === second.kind &&
    first.origin === second.origin &&
    first.token === second.token &&
    first.clientId === second.clientId
  );
}

/** Storage must be device-private. Sending owns only the immutable retired credential snapshot. */
export function createPendingRevocations(options: {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  send(entry: PendingRevocation): Promise<boolean>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let writes: Promise<unknown> = Promise.resolve();
  let flushing: Promise<void> | undefined;
  let empty = false;
  let revision = 0;
  const bound = (entries: PendingRevocation[]) => {
    entries.sort((a, b) => a.createdAt - b.createdAt);
    while (
      entries.length > MAX_PENDING_REVOCATIONS ||
      JSON.stringify(entries).length > MAX_REVOCATION_STORE_CHARS
    )
      entries.shift();
  };
  const update = <T>(work: (entries: PendingRevocation[]) => T | Promise<T>): Promise<T> => {
    const result = writes.then(async () => {
      const stored = await options.read();
      let entries: PendingRevocation[] = [];
      if (stored && stored.length <= MAX_REVOCATION_STORE_CHARS) {
        try {
          const parsed: unknown = JSON.parse(stored);
          if (Array.isArray(parsed)) entries = parsed.filter((entry) => valid(entry, now()));
        } catch {
          // Damaged records cannot authorize a request.
        }
      }
      bound(entries);
      const result = await work(entries);
      bound(entries);
      const serialized = JSON.stringify(entries);
      if (serialized !== stored) await options.write(serialized);
      empty = entries.length === 0;
      return result;
    });
    writes = result.catch(() => undefined);
    return result;
  };
  return {
    enqueue(entry: Omit<PendingRevocation, "createdAt">): Promise<void> {
      empty = false;
      const record = JSON.parse(
        JSON.stringify({ ...entry, createdAt: now() }),
      ) as PendingRevocation;
      if (!valid(record, now()) || JSON.stringify([record]).length > MAX_REVOCATION_STORE_CHARS)
        return Promise.reject(new Error("Invalid pending revocation"));
      return update((entries) => {
        if (!entries.some((previous) => same(previous, record))) {
          entries.push(record);
          revision += 1;
        }
      });
    },
    retry(): Promise<void> {
      if (flushing) return flushing;
      if (empty) return Promise.resolve();
      const attempt = (async () => {
        const attempted: PendingRevocation[] = [];
        let observed: number;
        do {
          observed = revision;
          const snapshot = await update((entries) =>
            entries
              .filter((entry) => !attempted.some((previous) => same(previous, entry)))
              .slice(0, MAX_PENDING_REVOCATIONS - attempted.length),
          );
          attempted.push(...snapshot);
          const completed = await Promise.all(
            snapshot.map(async (entry) => {
              try {
                return (await options.send(entry)) ? entry : null;
              } catch {
                return null;
              }
            }),
          );
          await update((entries) => {
            for (let index = entries.length - 1; index >= 0; index -= 1) {
              if (completed.some((entry) => entry && same(entry, entries[index]!)))
                entries.splice(index, 1);
            }
          });
        } while (observed !== revision && attempted.length < MAX_PENDING_REVOCATIONS);
      })();
      flushing = attempt.finally(() => {
        flushing = undefined;
      });
      return flushing;
    },
  };
}
