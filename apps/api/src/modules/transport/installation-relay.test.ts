// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash, generateKeyPairSync, randomUUID, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { Agent, request } from "node:http";
import { connect } from "node:tls";
import { InstallationTransport } from "@orkbot/adapters/installation-transport";
import type { InstallationClient, WorkspaceAuthority } from "@orkbot/auth";
import type { InstallationTransportLease } from "@orkbot/auth/installation-client";
import { InstallationRequestError } from "@orkbot/auth/installation-client";
import { createInstallationTlsIdentity, installationTlsName } from "@orkbot/auth/installation-tls";
import type { RelayAdmission } from "@orkbot/contracts";
import { RELAY_CHANNEL_PATH } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { isolatedRelay } from "@orkbot/relay/test-support";
import { afterEach, expect, it, vi } from "vitest";
import { createWebSocketStream, WebSocket } from "ws";
import { installationHttpListener } from "./installation-http.js";
import { startInstallationRelay } from "./installation-relay.js";

const state = vi.hoisted(() => ({ acquire: vi.fn(), active: vi.fn(), release: vi.fn() }));
vi.mock("@orkbot/auth/installation-transport-owner", () => ({
  InstallationTransportOwner: class {
    id = "20000000-0000-4000-8000-000000000001";
    acquire = state.acquire;
    active = state.active;
    release = state.release;
  },
}));
const configuration = {
  serverId: "10000000-0000-4000-8000-000000000001",
  organizationId: "10000000-0000-4000-8000-000000000002",
  bindingVersion: 1,
  keyFingerprint: "a".repeat(64),
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function services() {
  state.acquire.mockImplementation(async () => ({
    configuration,
    deadline: performance.now() + 60_000,
  }));
  state.active.mockResolvedValue(true);
  state.release.mockResolvedValue(undefined);
  const transportLease = vi.fn(
    async (): Promise<InstallationTransportLease> => ({
      configuration,
      ownerId: "20000000-0000-4000-8000-000000000001",
      expiresAt: Math.floor(Date.now() / 1000) + 45,
      deadline: performance.now() + 45_000,
    }),
  );
  const releaseTransport = vi.fn(async () => undefined);
  const refuseInstallation = vi.fn(async () => undefined);
  const synchronize = vi.fn(async () => undefined);
  const onError = vi.fn();
  const transport = { attach: vi.fn() } as unknown as InstallationTransport;
  const options = {
    prisma: {} as PrismaClient,
    installation: { transportLease, releaseTransport } as unknown as InstallationClient,
    authority: { refuseInstallation, synchronize } as unknown as WorkspaceAuthority,
    transport,
    onError,
  };
  return { options, transportLease, releaseTransport, refuseInstallation, synchronize, onError };
}

it("treats a known Accounts refusal as installation revocation", async () => {
  const f = services();
  f.transportLease.mockRejectedValue(new InstallationRequestError(401));
  const stop = startInstallationRelay(f.options);
  cleanups.push(stop);
  await vi.waitFor(() => expect(f.refuseInstallation).toHaveBeenCalledWith(configuration.serverId));
  expect(f.synchronize).not.toHaveBeenCalled();
});

it("retains local ownership when central release could not be confirmed", async () => {
  const f = services();
  f.releaseTransport.mockRejectedValue(new InstallationRequestError(503));
  const stop = startInstallationRelay(f.options);
  await vi.waitFor(() => expect(f.transportLease).toHaveBeenCalledOnce());
  await stop();
  expect(f.releaseTransport).toHaveBeenCalledOnce();
  expect(state.release).not.toHaveBeenCalled();
});

it("confirms central release before another local process can acquire ownership", async () => {
  const f = services();
  const order: string[] = [];
  f.releaseTransport.mockImplementation(async () => {
    order.push("central");
  });
  state.release.mockImplementation(async () => {
    order.push("local");
  });
  const stop = startInstallationRelay(f.options);
  await vi.waitFor(() => expect(f.transportLease).toHaveBeenCalledOnce());
  await stop();
  expect(order).toEqual(["central", "local"]);
});

it("connects and renews through real WSS with system trust and carries pinned inner TLS", async () => {
  const f = services();
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const fingerprint = createHash("sha256")
    .update(keys.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const identity = {
    ...(await createInstallationTlsIdentity(keys.privateKey, fingerprint)),
    serverId: configuration.serverId,
    bindingVersion: 1,
    keyFingerprint: fingerprint,
  };
  const hostname = installationTlsName(fingerprint);
  const tickets = new Map<string, RelayAdmission>();
  const network = await isolatedRelay(async (ticket) => {
    const value = tickets.get(ticket);
    if (!value) throw new Error("invalid ticket");
    tickets.delete(ticket);
    return value;
  });
  const { origin, relay } = network;
  cleanups.push(() => network.close());
  const transport = new InstallationTransport({
    origin: "http://127.0.0.1:5173",
    identity: async () => identity,
    listener: installationHttpListener("http://127.0.0.1:5173", (req) => {
      expect(new URL(req.url).origin).toBe("http://127.0.0.1:5173");
      return new Response(Buffer.alloc(2 * 1024 * 1024, 0x43));
    }),
  });
  cleanups.push(async () => transport.close());
  f.options.transport = transport;
  f.transportLease.mockImplementation(async () => {
    const token = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 45;
    tickets.set(token, {
      version: 1,
      kind: "server",
      serverId: configuration.serverId,
      bindingVersion: 1,
      keyFingerprint: fingerprint,
      leaseId: "20000000-0000-4000-8000-000000000001",
      relayOrigin: origin,
      expiresAt,
      validForSeconds: 45,
    });
    return {
      configuration: { ...configuration, keyFingerprint: fingerprint },
      ownerId: "20000000-0000-4000-8000-000000000001",
      expiresAt,
      deadline: performance.now() + 45_000,
      relay: { origin, ticket: token },
    };
  });
  const stop = startInstallationRelay(f.options);
  cleanups.push(stop);
  await vi.waitFor(() => expect(Reflect.get(relay, "controls").size).toBe(1));
  await vi.waitFor(() => expect(f.transportLease).toHaveBeenCalledTimes(2), { timeout: 12_000 });
  const ticket = randomUUID();
  tickets.set(ticket, {
    version: 1,
    kind: "channel",
    serverId: configuration.serverId,
    bindingVersion: 1,
    keyFingerprint: fingerprint,
    workspaceId: randomUUID(),
    relayOrigin: origin,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    validForSeconds: 60,
  });
  const endpoint = new URL(RELAY_CHANNEL_PATH, origin);
  endpoint.protocol = "wss:";
  const client = new WebSocket(endpoint, {
    headers: { authorization: `Bearer ${ticket}` },
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
  });
  client.on("error", () => undefined);
  cleanups.push(async () => {
    client.terminate();
  });
  const envelope = once(client, "message");
  const [message] = await envelope;
  expect(JSON.parse(message.toString()).keyFingerprint).toBe(fingerprint);
  const tls = connect({
    socket: createWebSocketStream(client),
    ca: new X509Certificate(Buffer.from(identity.certificate, "base64")).toString(),
    servername: hostname,
    minVersion: "TLSv1.3",
    ALPNProtocols: ["http/1.1"],
  });
  tls.on("error", () => undefined);
  cleanups.push(async () => {
    tls.destroy();
  });
  await once(tls, "secureConnect");
  expect(tls.authorized).toBe(true);
  const agent = new Agent();
  agent.createConnection = () => tls;
  cleanups.push(async () => agent.destroy());
  const call = request({
    hostname: "product.example.test",
    path: "/private",
    headers: { host: "127.0.0.1:5173", authorization: "Bearer product-token" },
    agent,
  });
  const result = once(call, "response");
  call.end();
  const [response] = await result;
  let size = 0;
  for await (const bytes of response) {
    expect([...bytes].every((byte) => byte === 0x43)).toBe(true);
    size += bytes.length;
  }
  expect(size).toBe(2 * 1024 * 1024);
  expect(f.refuseInstallation).not.toHaveBeenCalled();
  expect(f.onError).not.toHaveBeenCalled();
});
