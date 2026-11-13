// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { CLIENT_PROTOCOL_HEADER, CLIENT_PROTOCOL_VERSION } from "@orkbot/contracts";
import { cancelResponseBody, readResponseWithin, withAbort } from "@orkbot/core";
import { t } from "./i18n";
import { fetchInstallation, installationRevocationScope } from "./installation-transport";
import { serverHeaders } from "./server-headers";
import { currentSessionGeneration, registerSessionDiskCache } from "./session";

export interface NativeNotificationTransport {
  addListener(name: string, callback: (event: unknown) => void): { remove(): void };
  configureBackgroundSession(
    scope: string,
    endpoint: string,
    token: string,
    space: string,
  ): Promise<void>;
  respondBackgroundRequest(id: string, scope: string, status: number, body: string): Promise<void>;
  clearBackgroundSessions(): Promise<void>;
}

type Owner = {
  id: string;
  endpoint: string;
  token: string;
  space: string;
  identity: string;
  generation: number;
  buildHeaders: Record<string, string>;
  controllers: Set<AbortController>;
  ready: Promise<void>;
};
type Manager = {
  native: NativeNotificationTransport;
  owners: Map<string, Owner>;
};
const managers = new Map<NativeNotificationTransport, Manager>();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
let registered = false;
// Wrappers can refer to the same native module. Serialize its registrations, never its requests.
let writes: Promise<unknown> = Promise.resolve();

function current(owner: Owner): boolean {
  return (
    owner.generation === currentSessionGeneration() &&
    owner.identity === JSON.stringify(installationRevocationScope(owner.endpoint))
  );
}

function retire(manager: Manager, owner: Owner): void {
  manager.owners.delete(owner.id);
  for (const controller of owner.controllers) controller.abort();
}

function write(operation: () => Promise<void>): Promise<void> {
  const next = writes.then(operation, operation);
  writes = next.catch(() => undefined);
  return next;
}

async function acknowledge(manager: Manager, owner: Owner): Promise<void> {
  try {
    await owner.ready;
    if (!current(owner) || manager.owners.get(owner.id) !== owner)
      throw new Error("Native connection changed");
  } catch (error) {
    retire(manager, owner);
    throw error;
  }
}

function requestPath(procedure: unknown): string | undefined {
  switch (procedure) {
    case "me":
      return "/rpc/me";
    case "runs/list":
      return "/rpc/runs/list";
    case "threads/get":
      return "/rpc/threads/get";
    case "notifications/declineIncomingCall":
      return "/rpc/notifications/declineIncomingCall";
    default:
      return undefined;
  }
}

async function respond(manager: Manager, event: unknown): Promise<void> {
  if (!event || typeof event !== "object") return;
  const request = event as Record<string, unknown>;
  const { id, scope } = request;
  if (typeof id !== "string" || typeof scope !== "string" || !UUID.test(id) || !UUID.test(scope))
    return;
  const reply = (status: number, body = "") =>
    manager.native.respondBackgroundRequest(id, scope, status, body);
  const owner = manager.owners.get(scope);
  // Another wrapper may own this native request and will answer it.
  if (!owner) return;
  if (!current(owner)) {
    retire(manager, owner);
    await reply(401);
    return;
  }
  const path = requestPath(request.procedure);
  if (
    !path ||
    typeof request.input !== "string" ||
    new TextEncoder().encode(request.input).length > 64 * 1024
  ) {
    await reply(400);
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(request.input);
  } catch {
    await reply(400);
    return;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    await reply(400);
    return;
  }
  const controller = new AbortController();
  owner.controllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await withAbort(
      fetchInstallation(`${owner.endpoint}${path}`, {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        headers: {
          ...serverHeaders(owner.endpoint),
          ...owner.buildHeaders,
          "content-type": "application/json",
          origin: "orkbot://",
          "cache-control": "no-store",
          [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL_VERSION),
          authorization: `Bearer ${owner.token}`,
          ...(owner.space ? { "x-orkbot-space-id": owner.space } : {}),
        },
        body: JSON.stringify({ json: input }),
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (!response.ok) {
      cancelResponseBody(response);
      await reply(current(owner) ? response.status : 401);
      return;
    }
    const bytes = await readResponseWithin(response, {
      maxBytes: MAX_RESPONSE_BYTES,
      tooLargeMessage: "Notification response exceeds its limit",
      signal: controller.signal,
    });
    if (!current(owner)) {
      await reply(401);
      return;
    }
    await reply(response.status, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    await reply(current(owner) ? 503 : 401);
  } finally {
    clearTimeout(timeout);
    owner.controllers.delete(controller);
  }
}

/** Native services can use only the live app's exact installation and product session. */
export async function prepareNotificationTransport(
  bridge: Partial<NativeNotificationTransport> | null,
  endpoint: string,
  token: string,
  space: string,
): Promise<void> {
  const identity = installationRevocationScope(endpoint);
  if (!identity) return;
  if (
    !bridge?.addListener ||
    !bridge.configureBackgroundSession ||
    !bridge.respondBackgroundRequest ||
    !bridge.clearBackgroundSessions
  )
    throw new Error(t("Update Ork to connect to this server."));
  const native = bridge as NativeNotificationTransport;
  let manager = managers.get(native);
  if (!manager) {
    manager = { native, owners: new Map() };
    managers.set(native, manager);
    const captured = manager;
    native.addListener("onBackgroundRequest", (event) => {
      void respond(captured, event).catch(() => undefined);
    });
  }
  if (!registered) {
    registered = true;
    registerSessionDiskCache(() => {
      for (const manager of managers.values()) {
        for (const owner of manager.owners.values()) retire(manager, owner);
        void write(() => manager.native.clearBackgroundSessions()).catch(() => undefined);
      }
    });
  }
  for (const owner of manager.owners.values()) if (!current(owner)) retire(manager, owner);
  const generation = currentSessionGeneration();
  const encoded = JSON.stringify(identity);
  const matches = (owner: Owner) =>
    owner.endpoint === endpoint &&
    owner.token === token &&
    owner.space === space &&
    owner.identity === encoded &&
    owner.generation === generation;
  const existing = [...manager.owners.values()].find(matches);
  if (existing) return acknowledge(manager, existing);
  const [{ randomUUID }, { clientBuildHeaders }] = await Promise.all([
    import("expo-crypto"),
    import("./client-update"),
  ]);
  const concurrent = [...manager.owners.values()].find(matches);
  if (concurrent) return acknowledge(manager, concurrent);
  const owner: Owner = {
    id: randomUUID(),
    endpoint,
    token,
    space,
    identity: encoded,
    generation,
    buildHeaders: clientBuildHeaders(),
    controllers: new Set(),
    ready: Promise.resolve(),
  };
  if (!current(owner)) throw new Error("Native connection changed");
  for (const previous of manager.owners.values())
    if (previous.endpoint === endpoint && previous.space === space) retire(manager, previous);
  if (manager.owners.size >= 4) retire(manager, manager.owners.values().next().value!);
  manager.owners.set(owner.id, owner);
  const captured = manager;
  owner.ready = write(async () => {
    if (!current(owner) || captured.owners.get(owner.id) !== owner)
      throw new Error("Native connection changed");
    await native.configureBackgroundSession(owner.id, endpoint, token, space);
  });
  return acknowledge(manager, owner);
}
