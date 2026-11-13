// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { Agent, createServer, request } from "node:http";
import type { TLSSocket } from "node:tls";
import { connect } from "node:tls";
import { createInstallationTlsIdentity, installationTlsName } from "@orkbot/auth/installation-tls";
import {
  INSTALLATION_TRANSPORT_PATH,
  installationTransportIdentitySchema,
} from "@orkbot/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createWebSocketStream, WebSocket } from "ws";
import { InstallationTransport } from "./installation-transport.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(options: { unavailable?: boolean } = {}) {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const fingerprint = createHash("sha256")
    .update(keys.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  const identity = {
    ...(await createInstallationTlsIdentity(keys.privateKey, fingerprint)),
    serverId: "10000000-0000-4000-8000-000000000001",
    bindingVersion: 1,
    keyFingerprint: fingerprint,
  };
  const calls: Array<{
    method: string;
    path: string;
    headers: Record<string, unknown>;
    remote: string | undefined;
    size: number;
  }> = [];
  const events = new EventEmitter();
  const clients: WebSocket[] = [];
  const adapter = new InstallationTransport({
    origin: "https://server.example",
    identity: async () => {
      if (options.unavailable) throw new Error("not paired");
      return identity;
    },
    listener: async (req, res) => {
      res.once("close", () => events.emit("responseClosed"));
      const call = {
        method: req.method!,
        path: req.url!,
        headers: { ...req.headers },
        remote: req.socket.remoteAddress,
        size: 0,
      };
      calls.push(call);
      if (req.headers.authorization !== "Bearer test-product-token") {
        res.writeHead(401).end();
        return;
      }
      for await (const part of req) call.size += part.length;
      if (req.url === "/large") {
        res.writeHead(200).end(Buffer.alloc(2 * 1024 * 1024, 0x58));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      if (req.url === "/stream") return;
      res.end("data: done\n\n");
    },
  });
  const server = createServer();
  server.on("upgrade", adapter.handleUpgrade);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    adapter.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  return {
    adapter,
    server,
    identity,
    fingerprint,
    calls,
    events,
    clients,
    address: `ws://127.0.0.1:${port}${INSTALLATION_TRANSPORT_PATH}`,
  };
}

async function channel(
  f: Awaited<ReturnType<typeof fixture>>,
  options: { wrongPin?: boolean; tls12?: boolean } = {},
) {
  const ws = new WebSocket(f.address, {
    origin: "orkbot://",
    perMessageDeflate: false,
    maxPayload: 256 * 1024,
  });
  f.clients.push(ws);
  cleanup.push(() => {
    ws.terminate();
  });
  const [message, binary] = await once(ws, "message");
  expect(binary).toBe(false);
  const envelope = installationTransportIdentitySchema.parse(JSON.parse(message.toString()));
  expect(envelope.protocol).toBe("ork-installation-tls-v1");
  expect(envelope.serverId).toBe(f.identity.serverId);
  expect(envelope.bindingVersion).toBe(1);
  const certificate = new X509Certificate(Buffer.from(envelope.certificate, "base64"));
  const peerPin = createHash("sha256")
    .update(certificate.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  expect(peerPin).toBe(f.fingerprint);
  const socket = connect({
    socket: createWebSocketStream(ws, { highWaterMark: 64 * 1024 }),
    ca: certificate.toString(),
    servername: installationTlsName(options.wrongPin ? "0".repeat(64) : f.fingerprint),
    minVersion: options.tls12 ? "TLSv1.2" : "TLSv1.3",
    maxVersion: options.tls12 ? "TLSv1.2" : "TLSv1.3",
    ALPNProtocols: ["http/1.1"],
  });
  cleanup.push(() => {
    socket.destroy();
  });
  return socket;
}

async function openResponse(
  socket: TLSSocket,
  headers: Record<string, string> = {},
  body?: Buffer,
  path = "/api/private",
) {
  const agent = new Agent();
  agent.createConnection = () => socket;
  cleanup.push(() => {
    agent.destroy();
  });
  const result = request({
    hostname: "server.example",
    path,
    method: body ? "POST" : "GET",
    headers: {
      host: "server.example",
      origin: "orkbot://",
      authorization: "Bearer test-product-token",
      ...headers,
    },
    agent,
  });
  const ready = once(result, "response");
  if (body) {
    for (let offset = 0; offset < body.length; offset += 32 * 1024) {
      if (!result.write(body.subarray(offset, offset + 32 * 1024))) await once(result, "drain");
    }
  }
  result.end();
  const [response] = await ready;
  return response;
}

async function send(
  socket: TLSSocket,
  headers: Record<string, string> = {},
  body?: Buffer,
  path = "/api/private",
) {
  const response = await openResponse(socket, headers, body, path);
  let content = "";
  for await (const part of response) content += part;
  return { status: response.statusCode, content };
}

describe("installation transport", () => {
  it("serves normal authenticated HTTP over TLS 1.3 and opaque WebSocket bytes", async () => {
    const f = await fixture();
    const socket = await channel(f);
    await once(socket, "secureConnect");
    expect(socket.authorized).toBe(true);
    expect(socket.getProtocol()).toBe("TLSv1.3");
    const result = await send(socket, {}, Buffer.alloc(2 * 1024 * 1024, 0x42));
    expect(result).toEqual({ status: 200, content: "data: first\n\ndata: done\n\n" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/private",
      size: 2 * 1024 * 1024,
    });
    expect(f.calls[0]!.headers.authorization).toBe("Bearer test-product-token");
    expect(f.calls[0]!.remote).toBeUndefined();
  });

  it("strips forwarding headers and preserves the product bearer", async () => {
    const f = await fixture();
    const socket = await channel(f);
    await once(socket, "secureConnect");
    await send(socket, {
      forwarded: "for=127.0.0.1",
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-host": "attacker.example",
      "x-real-ip": "127.0.0.1",
    });
    expect(f.calls[0]!.headers).not.toHaveProperty("forwarded");
    expect(f.calls[0]!.headers).not.toHaveProperty("x-forwarded-for");
    expect(f.calls[0]!.headers).not.toHaveProperty("x-forwarded-host");
    expect(f.calls[0]!.headers).not.toHaveProperty("x-real-ip");
    expect(f.calls[0]!.headers.authorization).toBe("Bearer test-product-token");
  });

  it("bounds encrypted frames when the application writes a large response at once", async () => {
    const f = await fixture();
    const socket = await channel(f);
    await once(socket, "secureConnect");
    const result = await send(socket, {}, undefined, "/large");
    expect(result.status).toBe(200);
    expect(result.content).toBe("X".repeat(2 * 1024 * 1024));
  });

  it("refuses another logical origin before dispatching a request", async () => {
    const f = await fixture();
    const socket = await channel(f);
    await once(socket, "secureConnect");
    expect((await send(socket, { host: "other.example" })).status).toBe(421);
    expect(f.calls).toHaveLength(0);
  });

  it("rejects TLS 1.2 and a different pinned installation", async () => {
    const f = await fixture();
    for (const options of [{ tls12: true }, { wrongPin: true }]) {
      const socket = await channel(f, options);
      await expect(once(socket, "secureConnect")).rejects.toThrow();
    }
    expect(f.calls).toHaveLength(0);
  });

  it("rejects unpaired installations and browser origins before upgrading", async () => {
    const f = await fixture({ unavailable: true });
    for (const origin of ["orkbot://", "https://attacker.example"]) {
      const ws = new WebSocket(f.address, { origin });
      ws.on("error", () => undefined);
      cleanup.push(() => {
        ws.terminate();
      });
      const [, response] = await once(ws, "unexpected-response");
      expect(response.statusCode).toBe(origin === "orkbot://" ? 503 : 403);
      response.resume();
    }
    expect(f.calls).toHaveLength(0);
  });

  it("delivers an unfinished event stream and closes the server response on cancellation", async () => {
    const f = await fixture();
    const socket = await channel(f);
    await once(socket, "secureConnect");
    const response = await openResponse(socket, {}, undefined, "/stream");
    expect(response.statusCode).toBe(200);
    const iterator = response[Symbol.asyncIterator]();
    expect((await iterator.next()).value.toString()).toBe("data: first\n\n");
    const closed = once(f.events, "responseClosed");
    response.on("error", () => undefined);
    socket.destroy();
    await closed;
  });

  it("retains application authentication inside the encrypted channel", async () => {
    const f = await fixture();
    const socket = await channel(f);
    await once(socket, "secureConnect");
    expect((await send(socket, { authorization: "Bearer wrong-token" })).status).toBe(401);
    expect(f.calls).toHaveLength(1);
  });

  it("rejects plaintext WebSocket messages before HTTP dispatch", async () => {
    const f = await fixture();
    const ws = new WebSocket(f.address, { origin: "orkbot://" });
    cleanup.push(() => {
      ws.terminate();
    });
    await once(ws, "message");
    const closed = once(ws, "close");
    ws.send("GET /api/private HTTP/1.1\r\nHost: server.example\r\n\r\n");
    await closed;
    expect(f.calls).toHaveLength(0);
  });

  it("closes active channels and refuses further upgrades during shutdown", async () => {
    const f = await fixture();
    const socket = await channel(f);
    await once(socket, "secureConnect", { signal: AbortSignal.timeout(5000) });
    const closed = once(f.clients[0]!, "close", { signal: AbortSignal.timeout(5000) });
    f.adapter.close();
    await closed;
    socket.destroy();
    const ws = new WebSocket(f.address, { origin: "orkbot://" });
    ws.on("error", () => undefined);
    cleanup.push(() => {
      ws.terminate();
    });
    const [, response] = await once(ws, "unexpected-response", {
      signal: AbortSignal.timeout(5000),
    });
    expect(response.statusCode).toBe(404);
    response.resume();
  });
});
