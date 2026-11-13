// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { NativeHttpBridge } from "@orkbot/client-transport";
import { createNativeFetch } from "@orkbot/client-transport";
import type { InstallationRelayRoute, WorkspaceTarget } from "@orkbot/contracts";
import {
  installationRelayRouteSchema,
  installationVirtualOrigin,
  WorkspaceTargetSchema,
} from "@orkbot/contracts";
import { readBoundedJsonResponse } from "@orkbot/core";
import { fetchAccounts } from "./accounts-network";

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
  route?: InstallationRelayRoute,
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
  const relayTicket = async (relay: InstallationRelayRoute, signal?: AbortSignal) => {
    if (!current()) throw new Error("Native connection changed");
    const { accountsAuthorization } = await import("./accounts");
    const authorization = await accountsAuthorization();
    if (
      !current() ||
      !authorization ||
      JSON.stringify([authorization.issuer, authorization.subject]) !== account
    )
      throw new Error("Native connection changed");
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetchAccounts(`${issuer.origin}/api/identity/v2/relay-tickets`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authorization.accessToken}`,
        },
        body: JSON.stringify({
          organizationId: workspace.organizationId,
          serverId: workspace.serverId,
          workspaceId: workspace.workspaceId,
        }),
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("Could not continue");
      }
      const value = await readBoundedJsonResponse<{
        grant?: unknown;
        expiresAt?: unknown;
        relayOrigin?: unknown;
      }>(response, 32 * 1024, controller.signal);
      if (
        !current() ||
        value.relayOrigin !== relay.origin ||
        typeof value.grant !== "string" ||
        !value.grant ||
        value.grant.length > 16 * 1024 ||
        typeof value.expiresAt !== "number" ||
        !Number.isSafeInteger(value.expiresAt) ||
        value.expiresAt <= Date.now() / 1000 ||
        value.expiresAt > Date.now() / 1000 + 60
      )
        throw new Error("Native connection changed");
      return value.grant;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };
  const ready = enqueue(async () => {
    if (!current()) throw new Error("Native connection changed");
    let relay = route;
    if (!relay && origin === installationVirtualOrigin(workspace.serverId)) {
      const { selectedInstallationRelay } = await import("./selected-workspace");
      relay = await selectedInstallationRelay(account, origin);
      if (!relay) throw new Error("Native connection changed");
    }
    if (relay) {
      relay = installationRelayRouteSchema.parse(relay);
      if (
        origin !== installationVirtualOrigin(workspace.serverId) ||
        relay.origin === issuer.origin ||
        relay.origin === origin
      )
        throw new Error("Native connection changed");
    }
    if (!current()) throw new Error("Native connection changed");
    const bridge = await native();
    if (!current()) throw new Error("Native connection changed");
    session ??= await bridge.begin();
    const activeSession = session;
    await bridge.select(
      activeSession,
      version,
      JSON.stringify({
        account,
        origin,
        ...workspace,
        ...(relay ? { relayOrigin: relay.origin } : {}),
      }),
    );
    if (!current()) throw new Error("Native connection changed");
    const { randomUUID } = await import("expo-crypto");
    return createNativeFetch(
      bridge,
      {
        session: activeSession,
        revision: version,
        origin,
        current,
        ...(relay ? { relayTicket: (signal?: AbortSignal) => relayTicket(relay, signal) } : {}),
      },
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
  const virtual = url.hostname.endsWith(".installation.ork.invalid");
  if (!snapshot)
    return pinnedOrigins.has(url.origin) || virtual
      ? Promise.reject(new Error("Native connection changed"))
      : fallback(input, init);
  if (url.origin !== snapshot.origin && (pinnedOrigins.has(url.origin) || virtual))
    return Promise.reject(new Error("Native connection changed"));
  if (url.origin === snapshot.issuer || url.origin !== snapshot.origin)
    return fallback(input, init);
  return snapshot.ready.then((fetch) => fetch(input, init));
};
