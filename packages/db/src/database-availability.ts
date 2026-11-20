// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { abortableDelay } from "@orkbot/core";
import { getLogger } from "@orkbot/logging";

const CONNECTION_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "57P01",
  "57P02",
  "57P03",
  "P1001",
  "P1002",
  "P1017",
]);
const SOCKET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);
const observedDatabaseErrors = new WeakSet<object>();

class DatabaseRecoveryExpiredError extends Error {
  constructor() {
    super("Database recovery exceeded the lease deadline");
  }
}

/** Database/driver errors only; a fetch failure's socket cause belongs to its provider. */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (error instanceof DatabaseRecoveryExpiredError) return true;
  const seen = new Set<unknown>();
  const visit = (value: unknown, driver = false): boolean => {
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (observedDatabaseErrors.has(value)) return true;
    const item = value as {
      name?: string;
      kind?: string;
      code?: string;
      originalCode?: string;
      message?: string;
      cause?: unknown;
      meta?: { driverAdapterError?: unknown };
    };
    const code = item.originalCode ?? item.code ?? "";
    if (CONNECTION_CODES.has(code) || (driver && SOCKET_CODES.has(code))) return true;
    if (
      driver &&
      ["DatabaseNotReachable", "ConnectionClosed", "SocketTimeout"].includes(item.kind ?? "")
    )
      return true;
    if (
      /^(Connection terminated (unexpectedly|due to connection timeout)|Query read timeout|Connection ended unexpectedly)/.test(
        item.message ?? "",
      )
    )
      return true;
    if (item.meta?.driverAdapterError && visit(item.meta.driverAdapterError, true)) return true;
    // The adapter wraps a native driver cause (also outside Prisma known errors).
    if (
      item.cause &&
      visit(
        item.cause,
        driver ||
          item.name === "DriverAdapterError" ||
          item.code === "P2010" ||
          item.code === "P2028",
      )
    )
      return true;
    return false;
  };
  return visit(error);
}

let unavailableSince: number | undefined;

/** Called only at the database boundary, never for external providers. */
export function databaseOperationFailed(error: unknown): void {
  // An external provider can return the same native socket code. Only the pg
  // boundary can establish that this particular error belongs to the database.
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    SOCKET_CODES.has(error.code)
  )
    observedDatabaseErrors.add(error);
  if (!isDatabaseUnavailable(error) || unavailableSince !== undefined) return;
  unavailableSince = Date.now();
  getLogger().warn("db.unavailable");
}

export function databaseOperationSucceeded(): void {
  if (unavailableSince === undefined) return;
  const duration = Date.now() - unavailableSince;
  unavailableSince = undefined;
  getLogger().info("db.available", { "db.outage_ms": duration });
}

/** Only call with an idempotent DB operation: connection loss leaves commit outcome unknown. */
export async function retryDatabaseOperation<T>(
  operation: () => Promise<T>,
  options: { deadline: () => number; signal?: AbortSignal; delayMs?: number },
): Promise<T> {
  for (;;) {
    options.signal?.throwIfAborted();
    if (Date.now() >= options.deadline()) throw new DatabaseRecoveryExpiredError();
    try {
      const result = await operation();
      databaseOperationSucceeded();
      return result;
    } catch (error) {
      if (!isDatabaseUnavailable(error)) throw error;
      databaseOperationFailed(error);
      const remaining = options.deadline() - Date.now();
      if (remaining <= 0) throw error;
      await abortableDelay(Math.min(options.delayMs ?? 1_000, remaining), options.signal);
      options.signal?.throwIfAborted();
      if (Date.now() >= options.deadline()) throw error;
    }
  }
}
