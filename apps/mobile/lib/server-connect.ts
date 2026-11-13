// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import {
  parseServerConnectLink,
  parseServerInitializeLink,
  parseWorkspaceLink,
} from "@orkbot/contracts";

let pending: string | null = null;
let workspace: NonNullable<ReturnType<typeof parseWorkspaceLink>> | null = null;
export const pendingWorkspaceConnect = () => workspace;
export function clearWorkspaceConnect(
  expected: NonNullable<ReturnType<typeof parseWorkspaceLink>>,
) {
  if (workspace !== expected) return;
  workspace = null;
  for (const listener of listeners) listener();
}
let initialization: { server: string; secret: string; account?: string } | null = null;
const listeners = new Set<() => void>();

export const pendingServerConnect = () => pending;

/** Compatibility links disclose only their presence to the native picker. */
export const hasPendingServerInitialization = (server: string) =>
  pending === server && initialization?.server === server;

export function subscribeServerConnect(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Capture a server address only; following a link never grants access or saves a bookmark. */
export function receiveServerConnect(input: string): boolean {
  const target = parseWorkspaceLink(input);
  if (target) {
    workspace = target;
    pending = null;
    initialization = null;
    for (const listener of listeners) listener();
    return true;
  }
  const initialize = parseServerInitializeLink(input);
  const server = initialize?.server ?? parseServerConnectLink(input);
  if (!server) return false;
  initialization = initialize;
  workspace = null;
  pending = server;
  for (const listener of listeners) listener();
  return true;
}

/** Bind the operator's link only after the native picker confirms the server and account. */
export function confirmServerInitialization(server: string, account: string): void {
  if (pending === server && initialization?.server === server) initialization.account = account;
}

export function serverInitializationSecret(server: string, account: string): string | null {
  if (initialization?.server !== server || initialization.account !== account) return null;
  return initialization.secret;
}

export function completeServerInitialization(
  server: string,
  account: string,
  secret: string | null,
): void {
  if (
    initialization?.server === server &&
    initialization.account === account &&
    initialization.secret === secret
  )
    initialization = null;
}

export function clearServerInitialization(): void {
  initialization = null;
}

export function clearServerConnect(expected: string): void {
  if (pending !== expected) return;
  pending = null;
  for (const listener of listeners) listener();
}
