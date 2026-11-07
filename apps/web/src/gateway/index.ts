// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRootEnv } from "@orkbot/core/node/load-root-env";
import { resolveScreenProxySecret } from "../../../../packages/core/src/secrets-guard.js";
import { createGateway } from "./server.js";

loadRootEnv();

let host = "0.0.0.0";
let port = process.env.WEB_PORT ?? "5173";
const arguments_ = process.argv.slice(2);
for (let index = 0; index < arguments_.length; index++) {
  const value = arguments_[index];
  if (value === "--strictPort") continue;
  if (value === "--host" || value === "--port") {
    const setting = arguments_[++index];
    if (!setting) throw new Error(`Missing ${value} value`);
    if (value === "--host") host = setting;
    else port = setting;
  } else throw new Error(`Unsupported gateway option: ${value}`);
}
if (!/^\d+$/.test(port) || Number(port) > 65535)
  throw new Error("WEB_PORT must be a valid TCP port");
const server = createGateway({
  root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  api: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3100",
  screenSecret: resolveScreenProxySecret(process.env),
  allowedHosts: [
    process.env.ORKBOT_HOST ?? "localhost",
    ...(process.env.ORKBOT_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ],
  desktopStackToken: process.env.ORKBOT_DESKTOP_STACK_TOKEN,
  imageTag: process.env.ORKBOT_IMAGE_TAG,
  scriptSources: process.env.ORKBOT_CSP_SCRIPT_SRC,
  connectSources: process.env.ORKBOT_CSP_CONNECT_SRC,
  assetDelayMs: Number(process.env.ORKBOT_PERFORMANCE_ASSET_DELAY_MS ?? 0),
});
server.on("error", () => {
  process.stderr.write("Could not start the web gateway.\n");
  process.exitCode = 1;
});
server.listen(Number(port), host);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void server.shutdown();
  });
