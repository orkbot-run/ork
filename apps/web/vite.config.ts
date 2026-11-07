// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Vite configuration is preserved; browser shell retirement is an Ork addition.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { lingui } from "@lingui/vite-plugin";
import type { DesktopStackProbeResponse } from "@orkbot/contracts";
import { buildIdAt } from "@orkbot/contracts/client-build";
import {
  appContentSecurityPolicy,
  COMPUTER_SCREEN_PREFIX,
  COMPUTER_SCREEN_RUNTIME_PATH,
  contentSecurityPolicyFor,
  parseContentSecuritySources,
} from "@orkbot/contracts/content-security-policy";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { ViteDevServer } from "vite";
import { defineConfig, loadEnv } from "vite";
import { wuyingScreenAssets } from "../../packages/adapters/src/wuying-screen-assets.ts";
import { wuyingScreenPolicy } from "../../packages/adapters/src/wuying-screen-policy.ts";
import { resolveScreenProxySecret } from "../../packages/core/src/secrets-guard.ts";
import { apiProxy } from "./src/api-proxy.js";
import { attachNovncProxy } from "./src/gateway/screen.js";
import { browserShellRetirement } from "./src/pwa/retire-build.js";

const webPort = Number(process.env.WEB_PORT ?? 5173);
const DESKTOP_STACK_PROBE_PATH = "/.well-known/orkbot-desktop-stack";
const DESKTOP_STACK_TOKEN_HEADER = "x-orkbot-desktop-stack-token";

function equalStackToken(expected: string, supplied: string | string[] | undefined) {
  if (expected === "" || typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.byteLength === suppliedBytes.byteLength &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function attachDesktopStackProbe(server: ViteDevServer, token: string, imageTag: string) {
  server.middlewares.use((req, res, next) => {
    if (req.url?.split("?", 1)[0] !== DESKTOP_STACK_PROBE_PATH) {
      next();
      return;
    }
    if (!equalStackToken(token, req.headers[DESKTOP_STACK_TOKEN_HEADER])) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const body: DesktopStackProbeResponse = { ok: true, imageTag };
    res.statusCode = 200;
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  });
}

function sharedPageHeaders(req: IncomingMessage, res: ServerResponse, next: () => void) {
  if (req.url?.startsWith("/p/")) {
    res.setHeader("x-robots-tag", "noindex, nofollow");
    res.setHeader("referrer-policy", "no-referrer");
  }
  next();
}

export default defineConfig(({ command, mode }) => {
  // Names this build in every API request; the dev server has none, so the handshake stays off.
  const buildId = command === "build" ? buildIdAt(new Date()) : "";
  const rootEnv = loadEnv(mode, path.resolve(import.meta.dirname, "../.."), "");
  const api = process.env.API_PROXY_TARGET ?? rootEnv.API_PROXY_TARGET ?? "http://127.0.0.1:3100";
  const previewHost = process.env.ORKBOT_HOST ?? rootEnv.ORKBOT_HOST ?? "localhost";
  const allowedHosts = [
    previewHost,
    ...(process.env.ORKBOT_ALLOWED_HOSTS ?? rootEnv.ORKBOT_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  ];
  // Set by the server built from this config; reusing one config object for two servers would
  // leave the last one's list.
  let proxyHosts: readonly string[] | true = [];
  const proxy = apiProxy(api, () => proxyHosts);
  const screenProxySecret = () =>
    resolveScreenProxySecret({
      ...process.env,
      SCREEN_PROXY_SECRET: process.env.SCREEN_PROXY_SECRET ?? rootEnv.SCREEN_PROXY_SECRET,
      SANDBOX_SUPERVISOR_TOKEN:
        process.env.SANDBOX_SUPERVISOR_TOKEN ?? rootEnv.SANDBOX_SUPERVISOR_TOKEN,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? rootEnv.BETTER_AUTH_SECRET,
    });
  const desktopStackToken =
    process.env.ORKBOT_DESKTOP_STACK_TOKEN ?? rootEnv.ORKBOT_DESKTOP_STACK_TOKEN ?? "";
  const imageTag = process.env.ORKBOT_IMAGE_TAG ?? rootEnv.ORKBOT_IMAGE_TAG ?? "edge";
  // Invalid origins throw here, so the server refuses to start rather than serve a wider policy.
  const appPolicy = appContentSecurityPolicy({
    scriptSrc: parseContentSecuritySources(
      "ORKBOT_CSP_SCRIPT_SRC",
      process.env.ORKBOT_CSP_SCRIPT_SRC ?? rootEnv.ORKBOT_CSP_SCRIPT_SRC,
    ),
    connectSrc: parseContentSecuritySources(
      "ORKBOT_CSP_CONNECT_SRC",
      process.env.ORKBOT_CSP_CONNECT_SRC ?? rootEnv.ORKBOT_CSP_CONNECT_SRC,
    ),
  });
  return {
    build: {
      sourcemap: true,
      rolldownOptions: {
        output: {
          codeSplitting: {
            // Shared chunks that build schemas run before the entry chunk's body, so the Zod
            // config only lands in time when it ships inside Zod's own chunk.
            groups: [
              { name: "zod", test: /[\\/]node_modules[\\/]zod[\\/]|[\\/]src[\\/]zod-config\.ts$/ },
            ],
          },
        },
      },
    },
    define: { "import.meta.env.ORKBOT_BUILD": JSON.stringify(buildId) },
    plugins: [
      {
        // The API reads this to name the deployed build, and a tab fetches it to confirm the
        // server already serves a newer build before it reloads.
        name: "orkbot-build-id",
        apply: "build",
        generateBundle() {
          this.emitFile({ type: "asset", fileName: "build-id", source: `${buildId}\n` });
        },
      },
      react(),
      babel({ plugins: ["@lingui/babel-plugin-lingui-macro"] }),
      lingui(),
      tailwindcss(),
      browserShellRetirement(),
      {
        // Dev keeps React Refresh unrestricted in app pages; screen documents always use CSP.
        name: "orkbot-content-security-policy",
        generateBundle() {
          for (const [pathname, asset] of Object.entries(wuyingScreenAssets)) {
            this.emitFile({ type: "asset", fileName: pathname.slice(1), source: asset.source });
          }
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const pathname = req.url?.split("?", 1)[0] ?? "/";
            if (pathname.startsWith(COMPUTER_SCREEN_PREFIX)) {
              res.setHeader(
                "content-security-policy",
                contentSecurityPolicyFor(pathname, appPolicy, wuyingScreenPolicy)!,
              );
              if (pathname !== COMPUTER_SCREEN_RUNTIME_PATH)
                res.setHeader("x-frame-options", "SAMEORIGIN");
            }
            const asset = Object.hasOwn(wuyingScreenAssets, pathname)
              ? wuyingScreenAssets[pathname]
              : undefined;
            if (asset) {
              res.setHeader("content-type", asset.type);
              res.end(asset.source);
              return;
            }
            next();
          });
        },
      },
      {
        // A shared page's link is its only key: keep it out of search results and Referer.
        name: "orkbot-shared-page-headers",
        configureServer(server) {
          server.middlewares.use(sharedPageHeaders);
        },
      },
      {
        name: "orkbot-desktop-stack-probe",
        configureServer: (server) => attachDesktopStackProbe(server, desktopStackToken, imageTag),
      },
      {
        // The hosts the running server allows, as Vite resolved them, for proxied upgrades.
        name: "orkbot-api-proxy-hosts",
        configureServer: (server) => {
          proxyHosts = server.config.server.allowedHosts;
        },
      },
      {
        name: "orkbot-novnc-proxy",
        configureServer: (server) => attachNovncProxy(server, screenProxySecret(), api),
      },
    ],
    server: {
      host: process.env.ORKBOT_DEV_HOST ?? rootEnv.ORKBOT_DEV_HOST ?? "127.0.0.1",
      port: webPort,
      strictPort: true,
      allowedHosts,
      proxy,
    },
  };
});
