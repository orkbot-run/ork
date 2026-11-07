// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; neutral catalog state follows LICENSE.md.

import type {
  Connection,
  ConnectionCatalogItem,
  ConnectionCatalogSnapshot,
} from "@orkbot/contracts";
import { abortableDelay } from "./async.js";

type CatalogRef = Pick<ConnectionCatalogItem, "connectorId" | "slug">;

export function connectionCatalogState(snapshot: ConnectionCatalogSnapshot) {
  if (snapshot.providers.length === 0) return "unconfigured";
  const unavailable = snapshot.providers.filter(
    (provider) => provider.status === "unavailable",
  ).length;
  if (unavailable === snapshot.providers.length) return "error";
  if (unavailable > 0) return "partial";
  return snapshot.items.length === 0 ? "empty" : "ready";
}

/** Keep last-known apps only for providers whose current refresh failed. */
export function mergeConnectionCatalog(
  previous: readonly ConnectionCatalogItem[],
  snapshot: ConnectionCatalogSnapshot,
) {
  const unavailable = new Set(
    snapshot.providers
      .filter((provider) => provider.status === "unavailable")
      .map((provider) => provider.id),
  );
  const keys = new Set(snapshot.items.map(catalogItemKey));
  return [
    ...snapshot.items,
    ...previous
      .filter((item) => unavailable.has(item.connectorId) && !keys.has(catalogItemKey(item)))
      .map((item) => ({ ...item, connected: false })),
  ];
}

export function catalogItemConnectionState(
  connections: readonly Connection[],
  item: ConnectionCatalogItem,
) {
  if (isCatalogItemConnected(connections, item)) return "connected";
  const accounts = connections.filter(
    (row) =>
      row.connectorId === item.connectorId &&
      row.provider.toLowerCase() === item.slug.toLowerCase(),
  );
  if (accounts.some((row) => row.status === "pending")) return "pending";
  return accounts.some((row) => row.status === "error") ? "reconnect" : "disconnected";
}

export function catalogItemKey(item: CatalogRef) {
  return `${item.connectorId}:${item.slug}`;
}

/** Connected or still-authorizing accounts for one catalog app. */
export function catalogItemAccounts(connections: readonly Connection[], item: CatalogRef) {
  return connections.filter(
    (row) =>
      row.connectorId === item.connectorId &&
      row.provider.toLowerCase() === item.slug.toLowerCase() &&
      (row.status === "connected" || row.status === "pending"),
  );
}

export function isCatalogItemConnected(
  connections: readonly Connection[],
  item: ConnectionCatalogItem,
) {
  const rows = connections.filter(
    (row) =>
      row.connectorId === item.connectorId &&
      row.provider.toLowerCase() === item.slug.toLowerCase(),
  );
  return rows.length > 0 ? rows.some((row) => row.status === "connected") : item.connected;
}

/** "Gmail", then numbered accounts, skipping names already connected or authorizing. */
export function nextCatalogAccountLabel(
  connections: readonly Connection[],
  item: ConnectionCatalogItem,
) {
  const accounts = catalogItemAccounts(connections, item);
  const names = new Set(accounts.map((row) => row.displayName));
  let number = accounts.filter((row) => row.status === "connected").length + 1;
  let label = number === 1 ? item.name : `${item.name} ${number}`;
  while (names.has(label)) {
    number += 1;
    label = `${item.name} ${number}`;
  }
  return label;
}

const CATALOG_CONNECT_POLL_ATTEMPTS = 45;
const CATALOG_CONNECT_POLL_MS = 2_000;

/**
 * Begin a catalog connection, open its authorization page, and wait for it to finish.
 * Platforms supply transport and URL opening; the flow itself stays identical everywhere.
 */
export async function connectCatalogItem(
  item: ConnectionCatalogItem,
  connections: readonly Connection[],
  deps: {
    begin: (input: {
      connectorId: string;
      provider: string;
      displayName: string;
    }) => Promise<{ connectionId: string; authorizationUrl: string | null }>;
    complete: (input: { connectionId: string }) => Promise<Connection>;
    openUrl: (url: string) => unknown;
    signal: AbortSignal;
    isCurrent?: () => boolean;
  },
): Promise<
  { status: "connected"; row?: Connection } | { status: "pending" } | { status: "aborted" }
> {
  const stopped = () => deps.signal.aborted || deps.isCurrent?.() === false;
  const started = await deps.begin({
    connectorId: item.connectorId,
    provider: item.slug,
    displayName: nextCatalogAccountLabel(connections, item),
  });
  if (stopped()) return { status: "aborted" };
  if (started.authorizationUrl) await deps.openUrl(started.authorizationUrl);
  else if (item.noAuth) return { status: "connected" };
  return waitForConnection(started.connectionId, deps.complete, {
    signal: deps.signal,
    isCurrent: deps.isCurrent,
    attempts: CATALOG_CONNECT_POLL_ATTEMPTS,
  });
}

/**
 * Poll `connections/complete` until the connection is connected. A connection that was revoked
 * or no longer exists was superseded (a newer attempt, possibly on another device, or a removal),
 * so polling stops quietly as "aborted".
 */
export async function waitForConnection<Row extends { status: string }>(
  connectionId: string,
  complete: (input: { connectionId: string }) => Promise<Row>,
  options: { signal: AbortSignal; isCurrent?: () => boolean; attempts: number },
): Promise<{ status: "connected"; row: Row } | { status: "pending" } | { status: "aborted" }> {
  const stopped = () => options.signal.aborted || options.isCurrent?.() === false;
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    if (stopped()) return { status: "aborted" };
    let row: Row | undefined;
    try {
      row = await complete({ connectionId });
    } catch (error) {
      if (isNotFound(error)) return { status: "aborted" };
    }
    if (stopped()) return { status: "aborted" };
    if (row?.status === "connected") return { status: "connected", row };
    if (row?.status === "revoked") return { status: "aborted" };
    await abortableDelay(CATALOG_CONNECT_POLL_MS, options.signal);
  }
  return stopped() ? { status: "aborted" } : { status: "pending" };
}

/** The server's NOT_FOUND code, not any 404 a proxy or an older server might send. */
function isNotFound(error: unknown) {
  return (error as { code?: unknown } | null)?.code === "NOT_FOUND";
}
