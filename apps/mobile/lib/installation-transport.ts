// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { NativeHttpBridge } from "@orkbot/client-transport";
import { createNativeFetch } from "@orkbot/client-transport";
import type { WorkspaceTarget } from "@orkbot/contracts";
import { WorkspaceTargetSchema } from "@orkbot/contracts";

interface NativeInstallation extends NativeHttpBridge {
  begin(): Promise<string>;
  select(session: string, revision: number, target: string): Promise<void>;
  end(session: string): Promise<void>;
}

let revision = 0;
let session: string | null = null;
let queue: Promise<unknown> = Promise.resolve();
let loading: Promise<NativeInstallation> | undefined;
const pinnedOrigins = new Set<string>();
let selected: {
  origin: string;
  issuer: string;
  revision: number;
  ready: Promise<typeof fetch>;
} | null = null;
const native = () =>
  (loading ??= import("expo-modules-core").then((core) => {
    const bridge = core.requireOptionalNativeModule<NativeInstallation>("OrkTransport");
    if (!bridge) throw new Error("Update Ork to connect to this server.");
    return bridge;
  }));
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.catch(() => undefined);
  return result;
}

/** Invalidate synchronously; native cancellation also fences work already crossing the bridge. */
export function invalidateInstallationTransport(): void {
  ++revision;
  selected = null;
  if (loading)
    void enqueue(async () => {
      const bridge = await native();
      if (session) await bridge.end(session);
      session = null;
    }).catch(() => undefined);
}

export async function selectInstallationTransport(
  account: string,
  origin: string,
  target?: WorkspaceTarget,
): Promise<void> {
  if (!target) {
    invalidateInstallationTransport();
    return;
  }
  const workspace = WorkspaceTargetSchema.parse(target);
  const owner: unknown = JSON.parse(account);
  if (
    !Array.isArray(owner) ||
    owner.length !== 2 ||
    owner.some((item) => typeof item !== "string" || !item)
  )
    throw new Error("Could not continue");
  const issuer = new URL(owner[0]);
  const server = new URL(origin);
  if (issuer.protocol !== "https:" || server.origin !== origin || server.origin === issuer.origin)
    throw new Error("Could not continue");
  const version = ++revision;
  pinnedOrigins.add(origin);
  const current = () => selected?.revision === version && revision === version;
  const ready = enqueue(async () => {
    if (!current()) throw new Error("Native connection changed");
    const bridge = await native();
    if (!current()) throw new Error("Native connection changed");
    session ??= await bridge.begin();
    const activeSession = session;
    await bridge.select(activeSession, version, JSON.stringify({ account, origin, ...workspace }));
    if (!current()) throw new Error("Native connection changed");
    const { randomUUID } = await import("expo-crypto");
    return createNativeFetch(
      bridge,
      { session: activeSession, revision: version, origin, current },
      randomUUID,
    );
  });
  selected = { origin, issuer: issuer.origin, revision: version, ready };
  await ready;
}

/** Accounts always uses its own HTTP channel, even if a catalog contains a bad server origin. */
export const fetchInstallation = (
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  fallback: typeof fetch = fetch,
): ReturnType<typeof fetch> => {
  const snapshot = selected;
  const url = new URL(
    typeof input === "string" || input instanceof URL ? String(input) : input.url,
  );
  if (!snapshot)
    return pinnedOrigins.has(url.origin)
      ? Promise.reject(new Error("Native connection changed"))
      : fallback(input, init);
  if (url.origin !== snapshot.origin && pinnedOrigins.has(url.origin))
    return Promise.reject(new Error("Native connection changed"));
  if (url.origin === snapshot.issuer || url.origin !== snapshot.origin)
    return fallback(input, init);
  return snapshot.ready.then((fetch) => fetch(input, init));
};
