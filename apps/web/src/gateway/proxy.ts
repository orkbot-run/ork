// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { USER_DEVICE_CONNECT_PATH } from "@orkbot/contracts/user-devices";
import { appendForwardedFor } from "../forwarded-for.js";

const HEADERS_TIMEOUT_MS = 20_000;
const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function endToEnd(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const result = { ...headers };
  const connection = (headers.connection ?? "").split(",").map((name) => name.trim().toLowerCase());
  for (const name of [...HOP_HEADERS, ...connection]) delete result[name];
  return result;
}

function requestHeaders(req: IncomingMessage, target: URL, upgrade: boolean): OutgoingHttpHeaders {
  return {
    ...endToEnd(req.headers),
    host: target.host,
    "x-forwarded-for": appendForwardedFor(req),
    ...(upgrade ? { connection: "Upgrade", upgrade: "websocket" } : {}),
  };
}

/** Only protocol endpoints reach the API; browser callback pages stay on the gateway. */
export function apiRequestPath(pathname: string): boolean {
  return (
    pathname === "/callback" ||
    ["/api", "/rpc"].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) ||
    ["/.well-known/apple-app-site-association", "/.well-known/assetlinks.json"].includes(pathname)
  );
}

/** Streaming preserves uploads, cookies and event streams without buffering request bodies. */
export function proxyApiRequest(req: IncomingMessage, res: ServerResponse, target: URL) {
  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request({
    protocol: target.protocol,
    hostname: target.hostname.replace(/^\[|\]$/g, ""),
    port: target.port,
    method: req.method,
    path: req.url,
    headers: requestHeaders(req, target, false),
  });
  upstream.once("response", (incoming) => {
    if (res.destroyed) {
      incoming.destroy();
      return;
    }
    res.writeHead(incoming.statusCode ?? 502, endToEnd(incoming.headers));
    incoming.once("error", () => res.destroy());
    incoming.once("aborted", () => res.destroy());
    incoming.pipe(res);
  });
  upstream.once("error", () => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    });
    res.end("Server unavailable");
  });
  req.once("aborted", () => upstream.destroy());
  res.once("close", () => upstream.destroy());
  req.pipe(upstream);
}

export function rejectUpgrade(socket: Duplex, status = 404) {
  if (!socket.destroyed)
    socket.end(
      `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Not Found"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
}

/** The API's only WebSocket is matched before decoding or normalizing the request path. */
export function proxyDeviceUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: URL,
) {
  if (
    req.url?.split("?", 1)[0] !== USER_DEVICE_CONNECT_PATH ||
    req.headers.upgrade?.toLowerCase() !== "websocket"
  ) {
    rejectUpgrade(socket);
    return;
  }
  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request({
    protocol: target.protocol,
    hostname: target.hostname.replace(/^\[|\]$/g, ""),
    port: target.port,
    method: "GET",
    path: req.url,
    headers: requestHeaders(req, target, true),
  });
  const timer = setTimeout(() => {
    upstream.destroy();
    socket.destroy();
  }, HEADERS_TIMEOUT_MS);
  let peer: Duplex | undefined;
  const stop = () => {
    clearTimeout(timer);
    upstream.destroy();
    peer?.destroy();
  };
  socket.once("close", stop);
  socket.once("error", stop);
  upstream.once("error", () => {
    clearTimeout(timer);
    socket.destroy();
  });
  upstream.once("response", (incoming) => {
    clearTimeout(timer);
    socket.write(
      `HTTP/1.1 ${incoming.statusCode ?? 502} ${incoming.statusMessage ?? ""}\r\nConnection: close\r\n\r\n`,
    );
    incoming.pipe(socket);
    incoming.once("error", () => socket.destroy());
  });
  upstream.once("upgrade", (incoming, connected, incomingHead) => {
    clearTimeout(timer);
    peer = connected;
    if (socket.destroyed) {
      connected.destroy();
      return;
    }
    const lines = [
      `HTTP/1.1 ${incoming.statusCode ?? 101} ${incoming.statusMessage ?? "Switching Protocols"}`,
    ];
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      lines.push(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (incomingHead.length) socket.write(incomingHead);
    if (head.length) connected.write(head);
    connected.once("error", () => socket.destroy());
    connected.once("close", () => socket.destroy());
    connected.pipe(socket);
    socket.pipe(connected);
  });
  upstream.end();
}
