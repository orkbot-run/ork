// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Socket } from "node:net";
import { serve } from "@hono/node-server";
import { createApp } from "@orkbot/api/app";
import { stopOnShutdownSignals } from "@orkbot/core/node/shutdown-signals";

// This disposable topology exercises the API library with offline identity fixtures.
// The shipped API entrypoint independently requires the registered Accounts client.
const { app, stop, handleUpgrade } = await createApp();
const server = serve({
  fetch: app.fetch,
  port: Number(process.env.API_PORT ?? 3100),
  hostname: process.env.API_HOST ?? "0.0.0.0",
});
if (handleUpgrade) server.on("upgrade", handleUpgrade);

const sockets = new Set<Socket>();
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

let stopping = false;
stopOnShutdownSignals(async () => {
  if (stopping) return;
  stopping = true;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  const grace = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, 2_000);
  await closed;
  clearTimeout(grace);
  await stop();
});
