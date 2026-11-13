// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import dns from "node:dns";
import { once } from "node:events";
import { Agent, request } from "node:http";
import { createServer } from "node:https";
import { connect, getCACertificates, setDefaultCACertificates } from "node:tls";
import { createInstallationTlsIdentity, installationTlsName } from "@orkbot/auth/installation-tls";
import type { RelayAdmission, WorkspaceTarget } from "@orkbot/contracts";
import { installationTransportIdentitySchema, RELAY_CHANNEL_PATH } from "@orkbot/contracts";
import { createWebSocketStream, WebSocket } from "ws";
import { InstallationRelay } from "./relay.js";

/** Run the production relay behind real TLS using trust confined to this test process. */
export async function isolatedRelay(
  redeem: (ticket: string, signal: AbortSignal) => Promise<RelayAdmission>,
) {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const fingerprint = createHash("sha256")
    .update(keys.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const identity = await createInstallationTlsIdentity(keys.privateKey, fingerprint);
  const hostname = installationTlsName(fingerprint);
  const trusted = getCACertificates();
  const lookup = dns.lookup;
  const restore = () => {
    dns.lookup = lookup;
    setDefaultCACertificates(trusted);
  };
  setDefaultCACertificates([
    ...trusted,
    new X509Certificate(Buffer.from(identity.certificate, "base64")).toString(),
  ]);
  dns.lookup = ((name: string, options: unknown, callback?: (...args: unknown[]) => void) => {
    if (name !== hostname)
      return Reflect.apply(
        lookup,
        dns,
        [name, options, callback].filter((value) => value !== undefined),
      );
    const done = typeof options === "function" ? options : callback;
    if (options && typeof options === "object" && "all" in options && options.all)
      done?.(null, [{ address: "127.0.0.1", family: 4 }]);
    else done?.(null, "127.0.0.1", 4);
  }) as typeof dns.lookup;
  let relay: InstallationRelay | undefined;
  const front = createServer(
    {
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      SNICallback: (_name, callback) => callback(null, identity.context),
    },
    (req, res) => relay?.server.emit("request", req, res),
  );
  front.on("upgrade", (req, socket, head) => relay?.server.emit("upgrade", req, socket, head));
  try {
    front.listen(0, "127.0.0.1");
    await once(front, "listening");
    const origin = `https://${hostname}:${(front.address() as { port: number }).port}`;
    relay = new InstallationRelay({ origin, redeem });
    let closed = false;
    return {
      origin,
      relay,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await relay!.close();
          front.closeAllConnections();
          await new Promise<void>((resolve) => front.close(() => resolve()));
        } finally {
          restore();
        }
      },
    };
  } catch (error) {
    front.closeAllConnections();
    front.close();
    restore();
    throw error;
  }
}

/** Exercise the real relay, installation pin and HTTP application in cross-service tests. */
export async function relayRequest(input: {
  relayOrigin: string;
  ticket: string;
  target: WorkspaceTarget;
  origin: string;
  path: string;
  headers: Record<string, string>;
  method?: string;
  body?: string;
}): Promise<{ status: number; body: Buffer }> {
  const endpoint = new URL(RELAY_CHANNEL_PATH, input.relayOrigin);
  endpoint.protocol = "wss:";
  const socket = new WebSocket(endpoint, {
    headers: { authorization: `Bearer ${input.ticket}` },
    perMessageDeflate: false,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    maxPayload: 256 * 1024,
    handshakeTimeout: 8_000,
  });
  socket.on("error", () => undefined);
  const agent = new Agent();
  let tls: ReturnType<typeof connect> | undefined;
  const timer = setTimeout(() => {
    socket.terminate();
    tls?.destroy();
  }, 8_000);
  timer.unref();
  try {
    const [bytes, binary] = await once(socket, "message");
    if (binary || bytes.byteLength > 32 * 1024) throw new Error("Invalid installation envelope");
    const identity = installationTransportIdentitySchema.parse(JSON.parse(bytes.toString()));
    if (
      identity.serverId !== input.target.serverId ||
      identity.bindingVersion !== input.target.bindingVersion ||
      identity.keyFingerprint !== input.target.keyFingerprint
    )
      throw new Error("Unexpected installation identity");
    const certificate = new X509Certificate(Buffer.from(identity.certificate, "base64"));
    const fingerprint = createHash("sha256")
      .update(certificate.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex");
    if (fingerprint !== input.target.keyFingerprint) throw new Error("Unexpected installation key");
    tls = connect({
      socket: createWebSocketStream(socket, { highWaterMark: 64 * 1024 }),
      ca: certificate.toString(),
      servername: installationTlsName(fingerprint),
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ALPNProtocols: ["http/1.1"],
    });
    tls.on("error", () => undefined);
    await once(tls, "secureConnect");
    const connected = tls;
    agent.createConnection = () => connected;
    const call = request({
      hostname: new URL(input.origin).hostname,
      path: input.path,
      method: input.method ?? "GET",
      headers: { ...input.headers, host: new URL(input.origin).host },
      agent,
    });
    call.on("error", () => undefined);
    const responded = once(call, "response");
    call.end(input.body);
    const [response] = await responded;
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const bytes of response) {
      length += bytes.length;
      if (length > 16 * 1024 * 1024) throw new Error("Test response exceeds its limit");
      chunks.push(Buffer.from(bytes));
    }
    return { status: response.statusCode!, body: Buffer.concat(chunks) };
  } finally {
    clearTimeout(timer);
    agent.destroy();
    tls?.destroy();
    socket.terminate();
  }
}
