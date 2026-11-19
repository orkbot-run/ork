// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { once } from "node:events";
import type { AddressInfo, Socket } from "node:net";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { createApiHttpServer } from "./http-drain.js";

const hostname = "127.0.0.1";
const clients: Socket[] = [];
const servers: ReturnType<typeof createApiHttpServer>[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function start(
  fetch: Parameters<typeof createApiHttpServer>[0]["fetch"],
  handleUpgrade?: Parameters<typeof createApiHttpServer>[0]["handleUpgrade"],
  port = 0,
) {
  const api = createApiHttpServer({ hostname, fetch, handleUpgrade });
  servers.push(api);
  api.server.listen(port, hostname);
  await once(api.server, "listening");
  return { ...api, port: (api.server.address() as AddressInfo).port };
}

function client(port: number) {
  const socket = createConnection({ host: hostname, port });
  clients.push(socket);
  socket.on("error", () => undefined);
  let data = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    data += chunk;
  });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return {
    request(path: string, headers = "") {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n${headers}\r\n`);
    },
    write: (chunk: string) => socket.write(chunk),
    received: () => data,
    closed,
    isClosed: () => socket.destroyed,
  };
}

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((api) => api.drain(0)));
});

it("passes the native connection to Hono for client address resolution", async () => {
  const app = new Hono().get("/", (context) =>
    context.text(getConnInfo(context).remote.address ?? ""),
  );
  const api = await start(app.fetch);
  const response = await fetch(`http://${hostname}:${api.port}/`);
  expect(await response.text()).toBe(hostname);
});

function eventStream(data: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
      },
    }),
    { headers: { "Content-Type": "text/event-stream; charset=UTF-8" } },
  );
}

it("drains ordinary replies beyond two seconds while closing idle, SSE and upgraded connections", async () => {
  const handlerEntered = deferred();
  let requests = 0;
  const acceptUpgrade: NonNullable<Parameters<typeof createApiHttpServer>[0]["handleUpgrade"]> = (
    _request,
    socket,
  ) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
  };
  const api = await start(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/live") return eventStream("ready");
    if (path === "/slow") {
      requests++;
      handlerEntered.resolve();
      return new Response(await request.text());
    }
    if (path === "/new") requests++;
    return new Response(path);
  }, acceptUpgrade);

  const idle = client(api.port);
  const ordinary = client(api.port);
  const sse = client(api.port);
  const upgraded = client(api.port);
  idle.request("/idle");
  sse.request("/live");
  upgraded.request("/computer", "Connection: Upgrade\r\nUpgrade: websocket\r\n");
  ordinary.write("POST /slow HTTP/1.1\r\nHost: localhost\r\nContent-Length: 8\r\n\r\npart");
  await handlerEntered.promise;
  await expect.poll(idle.received).toContain("timeout=125");
  await expect.poll(sse.received).toContain("data: ready");
  await expect.poll(upgraded.received).toContain("101 Switching Protocols");
  const drained = api.drain();
  expect(api.drain()).toBe(drained);
  await expect.poll(() => idle.isClosed() && sse.isClosed() && upgraded.isClosed()).toBe(true);
  await delay(2_050);
  expect(ordinary.isClosed()).toBe(false);
  ordinary.write("more");
  ordinary.request("/new");
  await ordinary.closed;
  await drained;
  expect(requests).toBe(1);
  expect(ordinary.received()).toContain("HTTP/1.1 200 OK");
  expect(ordinary.received()).toContain("partmore");
  expect(ordinary.received()).toContain("HTTP/1.1 503 Service Unavailable");

  const replacement = await start(() => eventStream("replacement"), acceptUpgrade, api.port);
  const reconnected = client(replacement.port);
  const reconnectedUpgrade = client(replacement.port);
  reconnected.request("/live");
  reconnectedUpgrade.request("/computer", "Connection: Upgrade\r\nUpgrade: websocket\r\n");
  await expect.poll(reconnected.received).toContain("data: replacement");
  await expect.poll(reconnectedUpgrade.received).toContain("101 Switching Protocols");
});

it("closes a stream that opens after draining begins", async () => {
  const entered = deferred();
  const release = deferred();
  const cancelled = deferred();
  const api = await start(async () => {
    entered.resolve();
    await release.promise;
    return new Response(
      new ReadableStream({
        cancel: () => {
          cancelled.resolve();
        },
      }),
      {
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  });
  const pending = client(api.port);
  pending.request("/live");
  await entered.promise;
  const drained = api.drain();
  release.resolve();
  await Promise.all([pending.closed, cancelled.promise, drained]);
  expect(pending.received()).toBe("");
});

it("force-closes sockets when a handler does not finish within the grace period", async () => {
  const entered = deferred();
  const api = await start(() => {
    entered.resolve();
    return new Promise<Response>(() => undefined);
  });
  const hanging = client(api.port);
  hanging.request("/upload");
  await entered.promise;
  const drained = api.drain(30);
  expect(hanging.isClosed()).toBe(false);
  await Promise.all([drained, hanging.closed]);
  expect(hanging.received()).toBe("");
});
