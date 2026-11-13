// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import type { RelayAdmission } from "@orkbot/contracts";
import {
  RELAY_ATTACHMENT_PATH,
  RELAY_CHANNEL_PATH,
  RELAY_SERVER_PATH,
  relayRenewSchema,
} from "@orkbot/contracts";
import { WebSocket, WebSocketServer } from "ws";

type ServerAdmission = Extract<RelayAdmission, { kind: "server" }>;
interface Control {
  socket: WebSocket;
  admission: ServerAdmission;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  channels: Set<Channel>;
  busy: boolean;
}
interface Channel {
  id: string;
  secret: string;
  owner: Control;
  client: WebSocket;
  server?: WebSocket;
  timer: ReturnType<typeof setTimeout>;
}

const matches = (a: RelayAdmission, b: RelayAdmission) =>
  a.serverId === b.serverId &&
  a.bindingVersion === b.bindingVersion &&
  a.keyFingerprint === b.keyFingerprint;
const bearer = (request: IncomingMessage) => {
  const value = request.headers.authorization;
  return typeof value === "string" && /^Bearer [A-Za-z0-9_.-]{1,16384}$/.test(value)
    ? value.slice(7)
    : null;
};

/** A relay sees routing capabilities and opaque TLS records, never product HTTP credentials. */
export class InstallationRelay {
  readonly server;
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
  });
  private readonly controls = new Map<string, Control>();
  private readonly channels = new Map<string, Channel>();
  private readonly upgrades = new Set<Duplex>();
  private stopped = false;

  constructor(
    private readonly options: {
      redeem(ticket: string, signal: AbortSignal): Promise<RelayAdmission>;
      origin: string;
    },
  ) {
    const origin = new URL(options.origin);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== options.origin ||
      origin.username ||
      origin.password
    )
      throw new Error("Invalid relay origin");
    this.server = createServer({ maxHeaderSize: 32 * 1024 }, (request, response) => {
      response.setHeader("cache-control", "no-store");
      if (request.method === "GET" && ["/health", "/ready"].includes(request.url ?? "")) {
        response
          .writeHead(this.stopped ? 503 : 200, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: !this.stopped }));
      } else response.writeHead(404).end();
    });
    this.server.on("upgrade", this.upgrade);
    this.server.on("clientError", (_error, socket) => socket.destroy());
  }

  private upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const refuse = (status: number) => {
      if (!socket.destroyed)
        socket.end(
          `HTTP/1.1 ${status} Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
    };
    const path = request.url ?? "";
    const attachment = new RegExp(`^${RELAY_ATTACHMENT_PATH}/([a-f0-9-]{36})$`).exec(path);
    const ticket = bearer(request);
    if (
      this.stopped ||
      request.method !== "GET" ||
      (!attachment && path !== RELAY_SERVER_PATH && path !== RELAY_CHANNEL_PATH)
    )
      return refuse(404);
    if (
      !ticket ||
      request.headers.cookie ||
      (request.headers.origin && request.headers.origin !== "orkbot://")
    )
      return refuse(401);
    if (attachment) {
      const channel = this.channels.get(attachment[1]!);
      if (
        !channel ||
        channel.server ||
        channel.owner.deadline <= performance.now() ||
        ticket.length !== channel.secret.length ||
        !timingSafeEqual(Buffer.from(ticket), Buffer.from(channel.secret))
      )
        return refuse(401);
      this.wss.handleUpgrade(request, socket, head, (peer) => {
        peer.on("error", () => this.closeChannel(channel));
        channel.server = peer;
        channel.secret = "";
        clearTimeout(channel.timer);
        this.forward(channel.client, peer, channel);
        this.forward(peer, channel.client, channel);
      });
      return;
    }
    const startedAt = performance.now();
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
      socket.destroy();
    }, 8_000);
    timer.unref();
    this.upgrades.add(socket);
    const closed = () => abort.abort();
    socket.once("close", closed);
    void this.options
      .redeem(ticket, abort.signal)
      .then((admission) => {
        if (
          this.stopped ||
          socket.destroyed ||
          abort.signal.aborted ||
          admission.relayOrigin !== this.options.origin
        )
          return socket.destroy();
        const deadline =
          startedAt +
          Math.min(admission.validForSeconds, admission.kind === "server" ? 45 : 60) * 1000;
        if (deadline <= performance.now()) return refuse(401);
        if (path === RELAY_SERVER_PATH && admission.kind === "server") {
          const previous = this.controls.get(admission.serverId);
          this.wss.handleUpgrade(request, socket, head, (peer) =>
            this.control(peer, admission, deadline, previous),
          );
        } else if (path === RELAY_CHANNEL_PATH && admission.kind === "channel") {
          const control = this.controls.get(admission.serverId);
          if (
            !control ||
            !matches(control.admission, admission) ||
            control.deadline <= performance.now()
          )
            return refuse(503);
          if (
            control.channels.size >= 256 ||
            [...control.channels].filter((channel) => !channel.server).length >= 32
          )
            return refuse(429);
          this.wss.handleUpgrade(request, socket, head, (peer) => this.channel(peer, control));
        } else refuse(401);
      })
      .catch(() => refuse(401))
      .finally(() => {
        clearTimeout(timer);
        socket.off("close", closed);
        this.upgrades.delete(socket);
      });
  };

  private control(
    socket: WebSocket,
    admission: ServerAdmission,
    deadline: number,
    previous?: Control,
  ) {
    if (previous) this.closeControl(previous);
    const control: Control = {
      socket,
      admission,
      deadline,
      channels: new Set(),
      busy: false,
      timer: setTimeout(
        () => this.closeControl(control),
        Math.max(0, deadline - performance.now()),
      ),
    };
    control.timer.unref();
    this.controls.set(admission.serverId, control);
    socket.on("error", () => this.closeControl(control));
    socket.once("close", () => this.closeControl(control));
    socket.on("message", (bytes, binary) => {
      if (binary || !Buffer.isBuffer(bytes) || bytes.length > 32 * 1024 || control.busy)
        return this.closeControl(control);
      let parsed: ReturnType<typeof relayRenewSchema.parse>;
      try {
        parsed = relayRenewSchema.parse(JSON.parse(bytes.toString()));
      } catch {
        this.closeControl(control);
        return;
      }
      control.busy = true;
      const startedAt = performance.now();
      const signal = AbortSignal.timeout(6_000);
      void this.options
        .redeem(parsed.ticket, signal)
        .then((renewed) => {
          if (
            this.controls.get(admission.serverId) !== control ||
            control.deadline <= performance.now() ||
            renewed.kind !== "server" ||
            !matches(admission, renewed) ||
            renewed.leaseId !== admission.leaseId ||
            renewed.relayOrigin !== this.options.origin
          )
            return this.closeControl(control);
          const nextDeadline = startedAt + Math.min(45, renewed.validForSeconds) * 1000;
          if (nextDeadline <= performance.now()) return this.closeControl(control);
          control.deadline = nextDeadline;
          clearTimeout(control.timer);
          control.timer = setTimeout(
            () => this.closeControl(control),
            Math.max(0, nextDeadline - performance.now()),
          );
          control.timer.unref();
          this.sendControl(control, { version: 1, type: "ready", expiresAt: renewed.expiresAt });
        })
        .catch(() => this.closeControl(control))
        .finally(() => {
          control.busy = false;
        });
    });
    this.sendControl(control, { version: 1, type: "ready", expiresAt: admission.expiresAt });
  }

  private channel(client: WebSocket, owner: Control) {
    const id = randomUUID();
    const channel: Channel = {
      id,
      owner,
      client,
      secret: randomBytes(32).toString("base64url"),
      timer: setTimeout(() => this.closeChannel(channel), 8_000),
    };
    channel.timer.unref();
    this.channels.set(id, channel);
    owner.channels.add(channel);
    client.on("error", () => this.closeChannel(channel));
    client.once("close", () => this.closeChannel(channel));
    client.on("message", () => {
      if (!channel.server) this.closeChannel(channel);
    });
    this.sendControl(owner, { version: 1, type: "open", channelId: id, secret: channel.secret });
  }

  private sendControl(control: Control, value: unknown) {
    if (control.socket.readyState !== WebSocket.OPEN || control.socket.bufferedAmount > 64 * 1024)
      return this.closeControl(control);
    control.socket.send(JSON.stringify(value), { compress: false }, (error) => {
      if (error) this.closeControl(control);
    });
  }

  private forward(source: WebSocket, destination: WebSocket, channel: Channel) {
    source.once("close", () => this.closeChannel(channel));
    let pending = 0;
    source.on("message", (bytes, binary) => {
      if (!Buffer.isBuffer(bytes)) return this.closeChannel(channel);
      const size = bytes.length;
      pending += size;
      if (pending > 512 * 1024 || destination.readyState !== WebSocket.OPEN)
        return this.closeChannel(channel);
      source.pause();
      destination.send(bytes, { binary, compress: false }, (error) => {
        pending -= size;
        if (error) this.closeChannel(channel);
        else if (pending === 0 && source.readyState === WebSocket.OPEN) source.resume();
      });
    });
  }

  private closeChannel(channel: Channel) {
    clearTimeout(channel.timer);
    this.channels.delete(channel.id);
    channel.owner.channels.delete(channel);
    channel.client.terminate();
    channel.server?.terminate();
  }

  private closeControl(control: Control) {
    clearTimeout(control.timer);
    if (this.controls.get(control.admission.serverId) === control)
      this.controls.delete(control.admission.serverId);
    for (const channel of control.channels) this.closeChannel(channel);
    control.socket.terminate();
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const socket of this.upgrades) socket.destroy();
    for (const control of this.controls.values()) this.closeControl(control);
    for (const peer of this.wss.clients) peer.terminate();
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
