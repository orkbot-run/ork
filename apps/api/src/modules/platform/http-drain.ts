// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import type { Http2Bindings, HttpBindings } from "@hono/node-server";
import { getRequestListener } from "@hono/node-server";

const REQUEST_GRACE_MS = 20_000;
// Leave time for application cleanup and log flushing before Docker's 30s stop budget.
export const API_SHUTDOWN_DEADLINE_MS = 28_000;

type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

export function createApiHttpServer(options: {
  hostname: string;
  fetch: (request: Request, bindings: HttpBindings | Http2Bindings) => Response | Promise<Response>;
  handleUpgrade?: UpgradeHandler;
}) {
  const sockets = new Map<Duplex, { requests: number; liveStreams: number }>();
  let draining: Promise<void> | undefined;
  const listen = getRequestListener(
    async (request, bindings) => {
      const { incoming, outgoing } = bindings;
      const response = await options.fetch(request, bindings);
      const mediaType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (response.body && request.method !== "HEAD" && mediaType === "text/event-stream") {
        const connection = sockets.get(incoming.socket);
        if (connection) {
          connection.liveStreams += 1;
          outgoing.once("finish", () => {
            connection.liveStreams -= 1;
          });
        }
        // The handler can finish authenticating and open a stream after shutdown started.
        if (draining || incoming.socket.destroyed) {
          incoming.socket.destroy();
          void response.body.cancel().catch(() => undefined);
        }
      }
      return response;
    },
    { hostname: options.hostname },
  );

  const server = createServer(
    // Caddy keeps upstream connections idle for 120 seconds. Close after the proxy does.
    { keepAliveTimeout: 125_000, headersTimeout: 130_000 },
    (request, response) => {
      const socket = request.socket;
      const connection = sockets.get(socket)!;
      connection.requests += 1;
      response.once("finish", () => {
        connection.requests -= 1;
        // Flush all responses already accepted on this connection before sending FIN.
        if (draining && connection.requests === 0) socket.end();
      });
      if (draining) {
        response.writeHead(503, { "Retry-After": "1", "Content-Length": "0" });
        response.end();
        return;
      }
      void listen(request, response);
    },
  );
  server.on("connection", (socket) => {
    sockets.set(socket, { requests: 0, liveStreams: 0 });
    socket.once("close", () => sockets.delete(socket));
  });
  const handleUpgrade = options.handleUpgrade;
  if (handleUpgrade) {
    server.on("upgrade", (request, socket, head) => {
      if (draining) {
        socket.destroy();
        return;
      }
      // Upgraded connections are no longer owned by Node's HTTP connection management.
      sockets.get(socket)!.liveStreams += 1;
      handleUpgrade(request, socket, head);
    });
  }

  function drain(graceMs = REQUEST_GRACE_MS): Promise<void> {
    draining ??= new Promise<void>((resolve) => {
      const deadline = setTimeout(() => {
        for (const socket of sockets.keys()) socket.destroy();
      }, graceMs);
      // Node closes idle keep-alive connections as part of server.close().
      server.close(() => {
        clearTimeout(deadline);
        resolve();
      });
      for (const [socket, connection] of sockets) {
        if (connection.liveStreams > 0) socket.destroy();
      }
    });
    return draining;
  }

  return { server, drain };
}
