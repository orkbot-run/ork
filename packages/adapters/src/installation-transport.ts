// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { IncomingMessage, RequestListener } from "node:http";
import { createServer } from "node:http";
import { Duplex, Writable } from "node:stream";
import type { SecureContext } from "node:tls";
import { TLSSocket } from "node:tls";
import { INSTALLATION_TRANSPORT_PATH } from "@orkbot/contracts";
import type { WebSocket } from "ws";
import { createWebSocketStream, WebSocketServer } from "ws";

interface InstallationTlsIdentity {
  serverId: string;
  bindingVersion: number;
  keyFingerprint: string;
  certificate: string;
  context: SecureContext;
}

function encryptedStream(socket: WebSocket): Duplex {
  const wire = createWebSocketStream(socket, { highWaterMark: 64 * 1024 });
  const outgoing = new Writable({
    highWaterMark: 64 * 1024,
    write(bytes: Buffer, _encoding, done) {
      let offset = 0;
      const next = (error?: Error | null) => {
        if (error) return done(error);
        if (offset === bytes.length) return done();
        if (wire.destroyed) return done(new Error("Installation transport closed"));
        const end = Math.min(offset + 64 * 1024, bytes.length);
        const part = bytes.subarray(offset, end);
        offset = end;
        wire.write(part, next);
      };
      next();
    },
    final(done) {
      wire.end(done);
    },
    destroy(error, done) {
      wire.destroy();
      done(error);
    },
  });
  // TLS may encrypt a whole HTTP write at once. Bound frames regardless of that write's size.
  return Duplex.from({ readable: wire, writable: outgoing });
}

/** Adapts opaque socket bytes to the normal authenticated HTTP application. */
export class InstallationTransport {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
  });
  private readonly sockets = new Set<TLSSocket>();
  private readonly pending = new Set<Duplex>();
  private readonly relaySockets = new Set<WebSocket>();
  private closed = false;
  private readonly http;
  private readonly authority: string;

  constructor(
    private readonly options: {
      origin: string;
      identity: () => Promise<InstallationTlsIdentity>;
      listener: RequestListener;
    },
  ) {
    const url = new URL(options.origin);
    if (
      url.origin !== options.origin ||
      url.username ||
      url.password ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      throw new Error("Invalid installation transport origin");
    this.authority = url.host;
    this.http = createServer(
      { maxHeaderSize: 32 * 1024, headersTimeout: 10_000, requestTimeout: 0 },
      (request, response) => {
        const socket = request.socket;
        if (
          !(socket instanceof TLSSocket) ||
          socket.getProtocol() !== "TLSv1.3" ||
          socket.alpnProtocol !== "http/1.1" ||
          request.headers.host !== this.authority ||
          !request.url?.startsWith("/") ||
          request.url.startsWith("//")
        ) {
          response.writeHead(421).end();
          return;
        }
        // The outer proxy and relay cannot supply an authenticated client IP or host.
        const untrusted = (name: string) =>
          name === "forwarded" || name.startsWith("x-forwarded-") || name === "x-real-ip";
        for (const name of Object.keys(request.headers))
          if (untrusted(name)) delete request.headers[name];
        request.rawHeaders = request.rawHeaders.flatMap((value, index, values) =>
          index % 2 === 0 && !untrusted(value.toLowerCase()) ? [value, values[index + 1]!] : [],
        );
        response.shouldKeepAlive = false;
        options.listener(request, response);
      },
    );
    this.http.maxRequestsPerSocket = 1;
    this.http.on("clientError", (_error, socket) => socket.destroy());
    this.http.on("upgrade", (_request, socket) => socket.destroy());
    this.http.on("connect", (_request, socket) => socket.destroy());
  }

  accepts(request: IncomingMessage) {
    return request.url === INSTALLATION_TRANSPORT_PATH;
  }

  handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (status: number) => {
      if (!socket.destroyed)
        socket.end(
          `HTTP/1.1 ${status} Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
    };
    if (this.closed || !this.accepts(request)) return reject(404);
    if (request.headers.origin && request.headers.origin !== "orkbot://") return reject(403);
    this.pending.add(socket);
    const onError = () => socket.destroy();
    const timer = setTimeout(() => socket.destroy(), 8_000);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      this.pending.delete(socket);
    };
    socket.on("error", onError);
    socket.once("close", cleanup);
    void this.options
      .identity()
      .then((identity) => {
        cleanup();
        if (this.closed || socket.destroyed) return socket.destroy();
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          socket.off("error", onError);
          this.attachIdentity(ws, identity);
        });
      })
      .catch(() => {
        cleanup();
        reject(503);
      });
  };

  /** Attach an outbound relay socket after its one-time routing capability was accepted. */
  async attach(socket: WebSocket): Promise<void> {
    if (this.closed || socket.readyState !== 1) throw new Error("Installation transport closed");
    this.relaySockets.add(socket);
    socket.once("close", () => this.relaySockets.delete(socket));
    const early = () => socket.terminate();
    socket.on("message", early);
    const timer = setTimeout(() => socket.terminate(), 8_000);
    timer.unref();
    try {
      const identity = await this.options.identity();
      if (this.closed || socket.readyState !== 1) throw new Error("Installation transport closed");
      socket.off("message", early);
      this.attachIdentity(socket, identity);
    } catch (error) {
      socket.terminate();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private attachIdentity(ws: WebSocket, identity: InstallationTlsIdentity) {
    ws.on("error", () => ws.terminate());
    ws.on("message", (_bytes, binary) => {
      if (!binary) ws.terminate();
    });
    ws.send(
      JSON.stringify({
        protocol: "ork-installation-tls-v1",
        serverId: identity.serverId,
        bindingVersion: identity.bindingVersion,
        keyFingerprint: identity.keyFingerprint,
        certificate: identity.certificate,
        origin: this.options.origin,
      }),
    );
    const encrypted = encryptedStream(ws);
    const tls = new TLSSocket(encrypted, {
      isServer: true,
      secureContext: identity.context,
      ALPNProtocols: ["http/1.1"],
      requestCert: false,
    });
    this.sockets.add(tls);
    const handshake = setTimeout(() => tls.destroy(), 8_000);
    handshake.unref();
    const stopHandshake = () => clearTimeout(handshake);
    // Decrypted data appears only after Node's TLS handshake succeeds.
    tls.once("data", stopHandshake);
    tls.on("error", () => tls.destroy());
    encrypted.on("error", () => tls.destroy());
    tls.once("close", () => {
      stopHandshake();
      this.sockets.delete(tls);
      encrypted.destroy();
      ws.terminate();
    });
    this.http.emit("connection", tls);
  }

  close() {
    this.closed = true;
    for (const socket of this.pending) socket.destroy();
    for (const socket of this.sockets) socket.destroy();
    for (const client of this.wss.clients) client.terminate();
    for (const client of this.relaySockets) client.terminate();
    this.wss.close();
    this.http.closeAllConnections();
  }
}
