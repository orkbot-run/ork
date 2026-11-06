// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { parseServerConnectLink } from "@orkbot/contracts";

let pending: string | null = null;
const listeners = new Set<() => void>();

export const pendingServerConnect = () => pending;

export function subscribeServerConnect(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Capture a server address only; following a link never grants access or saves a bookmark. */
export function receiveServerConnect(input: string): boolean {
  const server = parseServerConnectLink(input);
  if (!server) return false;
  pending = server;
  for (const listener of listeners) listener();
  return true;
}

export function clearServerConnect(expected: string): void {
  if (pending !== expected) return;
  pending = null;
  for (const listener of listeners) listener();
}
