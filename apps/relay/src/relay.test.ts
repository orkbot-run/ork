// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash, generateKeyPairSync, randomUUID, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { Agent, request } from "node:http";
import { connect } from "node:tls";
import { InstallationTransport } from "@orkbot/adapters/installation-transport";
import { createInstallationTlsIdentity, installationTlsName } from "@orkbot/auth/installation-tls";
import type { RelayAdmission } from "@orkbot/contracts";
import { RELAY_ATTACHMENT_PATH, RELAY_CHANNEL_PATH, RELAY_SERVER_PATH } from "@orkbot/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createWebSocketStream, WebSocket } from "ws";
import { InstallationRelay } from "./relay.js";

const origin = "https://relay.example.test";
const serverId = "10000000-0000-4000-8000-000000000001";
const leaseId = "10000000-0000-4000-8000-000000000002";
const workspaceId = "10000000-0000-4000-8000-000000000003";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture() {
  const tickets = new Map<string, RelayAdmission>();
  const redeemed = new Set<string>();
  const redeem = vi.fn(async (ticket: string) => {
    const admission = tickets.get(ticket);
    if (!admission || redeemed.has(ticket)) throw new Error("ticket refused");
    redeemed.add(ticket);
    return admission;
  });
  const relay = new InstallationRelay({ origin, redeem });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const address = `ws://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
  const peers = new Set<WebSocket>();
  cleanups.push(async () => {
    for (const peer of peers) peer.terminate();
    await relay.close();
  });
  const peer = (path: string, ticket: string, headers: Record<string, string | undefined> = {}) => {
    const socket = new WebSocket(`${address}${path}`, {
      headers: { authorization: `Bearer ${ticket}`, ...headers },
      perMessageDeflate: false,
    });
    peers.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => peers.delete(socket));
    return socket;
  };
  const mint = (kind: "server" | "channel", changes: Partial<RelayAdmission> = {}) => {
    const token = randomUUID();
    tickets.set(token, {
      version: 1,
      relayOrigin: origin,
      serverId,
      bindingVersion: 1,
      keyFingerprint: "a".repeat(64),
      expiresAt: Math.floor(Date.now() / 1000) + 45,
      validForSeconds: 45,
      ...(kind === "server" ? { kind, leaseId } : { kind, workspaceId }),
      ...changes,
    } as RelayAdmission);
    return token;
  };
  const control = async (changes: Partial<RelayAdmission> = {}) => {
    const socket = peer(RELAY_SERVER_PATH, mint("server", changes));
    const ready = once(socket, "message");
    await once(socket, "open");
    expect(JSON.parse((await ready)[0].toString())).toMatchObject({ version: 1, type: "ready" });
    return socket;
  };
  const pair = async (control: WebSocket, changes: Partial<RelayAdmission> = {}) => {
    const opened = once(control, "message");
    const client = peer(RELAY_CHANNEL_PATH, mint("channel", changes));
    await once(client, "open");
    const message = JSON.parse((await opened)[0].toString());
    expect(message).toMatchObject({ version: 1, type: "open" });
    const server = peer(`${RELAY_ATTACHMENT_PATH}/${message.channelId}`, message.secret);
    await once(server, "open");
    return { client, server, message };
  };
  return { relay, peer, mint, control, pair, redeem, tickets };
}

it("forwards envelope text and bounded binary records in both directions", async () => {
  const f = await fixture();
  const control = await f.control();
  const { client, server } = await f.pair(control);
  const envelope = once(client, "message");
  server.send('{"certificate":"public"}');
  const [bytes, binary] = await envelope;
  expect(binary).toBe(false);
  expect(bytes.toString()).toBe('{"certificate":"public"}');
  for (const [source, destination] of [
    [client, server],
    [server, client],
  ] as const) {
    let size = 0;
    const complete = new Promise<void>((resolve) => {
      destination.on("message", (part, encrypted) => {
        expect(encrypted).toBe(true);
        expect(Buffer.isBuffer(part)).toBe(true);
        expect([...(part as Buffer)].every((byte) => byte === 0x42)).toBe(true);
        size += (part as Buffer).length;
        if (size === 2 * 1024 * 1024) resolve();
      });
    });
    for (let offset = 0; offset < 2 * 1024 * 1024; offset += 64 * 1024)
      await new Promise<void>((resolve, reject) =>
        source.send(Buffer.alloc(64 * 1024, 0x42), { binary: true }, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    await complete;
    destination.removeAllListeners("message");
  }
});

it("closes the partner on cancellation and cannot reuse its attachment capability", async () => {
  const f = await fixture();
  const { client, server, message } = await f.pair(await f.control());
  const closed = once(server, "close");
  client.terminate();
  await closed;
  await expect(
    once(f.peer(`${RELAY_ATTACHMENT_PATH}/${message.channelId}`, message.secret), "open"),
  ).rejects.toThrow("401");
});

it("refuses application bytes until the installation joins the channel", async () => {
  const f = await fixture();
  const control = await f.control();
  const opening = once(control, "message");
  const client = f.peer(RELAY_CHANNEL_PATH, f.mint("channel"));
  await once(client, "open");
  await opening;
  const closed = once(client, "close");
  client.send(Buffer.from("untrusted early bytes"));
  await closed;
});

it("refuses ticket replay, purpose mismatch, another relay, and another installation pin", async () => {
  const f = await fixture();
  const token = f.mint("server");
  const control = f.peer(RELAY_SERVER_PATH, token);
  await once(control, "open");
  await expect(once(f.peer(RELAY_SERVER_PATH, token), "open")).rejects.toThrow("401");
  await expect(once(f.peer(RELAY_SERVER_PATH, f.mint("channel")), "open")).rejects.toThrow("401");
  await expect(
    once(f.peer(RELAY_CHANNEL_PATH, f.mint("channel", { keyFingerprint: "b".repeat(64) })), "open"),
  ).rejects.toThrow("503");
  await expect(
    once(
      f.peer(RELAY_CHANNEL_PATH, f.mint("channel", { relayOrigin: "https://other.example.test" })),
      "open",
    ),
  ).rejects.toThrow();
});

it.each([{ origin: "https://site.example.test" }, { cookie: "session=untrusted" }])(
  "rejects browser authority before ticket redemption (%j)",
  async (headers) => {
    const f = await fixture();
    await expect(
      once(f.peer(RELAY_SERVER_PATH, f.mint("server"), headers), "open"),
    ).rejects.toThrow("401");
    expect(f.redeem).not.toHaveBeenCalled();
  },
);

it("closes channels on control replacement without letting the old close delete the new control", async () => {
  const f = await fixture();
  const first = await f.control();
  const { client } = await f.pair(first);
  const closed = once(client, "close");
  const second = await f.control({ leaseId: randomUUID() });
  await closed;
  const fresh = await f.pair(second);
  expect(fresh.client.readyState).toBe(WebSocket.OPEN);
});

it("bounds admission by a monotonic deadline and closes an expired control", async () => {
  const f = await fixture();
  const control = await f.control({ validForSeconds: 1 });
  const closed = once(control, "close");
  await closed;
  await expect(once(f.peer(RELAY_CHANNEL_PATH, f.mint("channel")), "open")).rejects.toThrow("503");
});

it("renews only the current control identity with another single-use ticket", async () => {
  const f = await fixture();
  const control = await f.control();
  const ready = once(control, "message");
  control.send(JSON.stringify({ version: 1, type: "renew", ticket: f.mint("server") }));
  expect(JSON.parse((await ready)[0].toString())).toMatchObject({ type: "ready" });
  const closed = once(control, "close");
  control.send(
    JSON.stringify({
      version: 1,
      type: "renew",
      ticket: f.mint("server", { leaseId: randomUUID() }),
    }),
  );
  await closed;
});

it("carries real TLS 1.3 HTTP and multi-megabyte files without exposing credentials to the relay", async () => {
  const f = await fixture();
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const fingerprint = createHash("sha256")
    .update(keys.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const identity = {
    ...(await createInstallationTlsIdentity(keys.privateKey, fingerprint)),
    serverId,
    bindingVersion: 1,
    keyFingerprint: fingerprint,
  };
  const adapter = new InstallationTransport({
    origin: "https://server.example.test",
    identity: async () => identity,
    listener: async (req, res) => {
      if (req.headers.authorization !== "Bearer private-product-credential")
        return res.writeHead(401).end();
      let size = 0;
      for await (const chunk of req) size += chunk.length;
      if (size !== 2 * 1024 * 1024) return res.writeHead(400).end();
      res.writeHead(201).end(Buffer.alloc(2 * 1024 * 1024, 0x43));
    },
  });
  cleanups.push(async () => adapter.close());
  const control = await f.control({ keyFingerprint: fingerprint });
  const { client, server } = await f.pair(control, { keyFingerprint: fingerprint });
  const capture: Buffer[] = [];
  // Instrument only the relay's own server-side peers, where records must remain encrypted.
  const relayPeers = Reflect.get(f.relay, "wss") as { clients: Set<WebSocket> };
  for (const peer of relayPeers.clients)
    peer.on("message", (bytes) => {
      if (Buffer.isBuffer(bytes)) capture.push(Buffer.from(bytes));
    });
  const envelope = once(client, "message");
  await adapter.attach(server);
  const [metadata, binary] = await envelope;
  expect(binary).toBe(false);
  const certificate = new X509Certificate(
    Buffer.from(JSON.parse(metadata.toString()).certificate, "base64"),
  );
  expect(
    createHash("sha256")
      .update(certificate.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  ).toBe(fingerprint);
  const tls = connect({
    socket: createWebSocketStream(client, { highWaterMark: 64 * 1024 }),
    ca: certificate.toString(),
    servername: installationTlsName(fingerprint),
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    ALPNProtocols: ["http/1.1"],
  });
  tls.on("error", () => undefined);
  cleanups.push(async () => {
    tls.destroy();
  });
  await once(tls, "secureConnect");
  expect(tls.authorized).toBe(true);
  expect(tls.getProtocol()).toBe("TLSv1.3");
  const agent = new Agent();
  agent.createConnection = () => tls;
  cleanups.push(async () => agent.destroy());
  const upload = request({
    hostname: "server.example.test",
    path: "/private-files",
    method: "POST",
    agent,
    headers: { host: "server.example.test", authorization: "Bearer private-product-credential" },
  });
  const response = once(upload, "response");
  for (let offset = 0; offset < 2 * 1024 * 1024; offset += 32 * 1024)
    if (!upload.write(Buffer.alloc(32 * 1024, 0x42))) await once(upload, "drain");
  upload.end();
  const [download] = await response;
  expect(download.statusCode).toBe(201);
  let size = 0;
  for await (const bytes of download) {
    expect([...bytes].every((byte) => byte === 0x43)).toBe(true);
    size += bytes.length;
  }
  expect(size).toBe(2 * 1024 * 1024);
  const all = Buffer.concat(capture);
  expect(all.includes("private-product-credential")).toBe(false);
  expect(all.includes("/private-files")).toBe(false);
  expect(all.includes(Buffer.alloc(128, 0x42))).toBe(false);
  expect(all.includes(Buffer.alloc(128, 0x43))).toBe(false);
});
