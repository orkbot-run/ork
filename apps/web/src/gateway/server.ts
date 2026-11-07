// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import {
  appContentSecurityPolicy,
  COMPUTER_SCREEN_RUNTIME_PATH,
  CSP_REPORTING_ENDPOINTS,
  contentSecurityPolicyFor,
  parseContentSecuritySources,
} from "@orkbot/contracts/content-security-policy";
import { wuyingScreenPolicy } from "../../../../packages/adapters/src/wuying-screen-policy.js";
import { createServiceLogger } from "../../../../packages/logging/src/env.js";
import { hostAllowed } from "../api-proxy.js";
import { ASSET_ARCHIVE_DIR, archiveAssets } from "../asset-archive.js";
import { missingAssetMiddleware } from "../missing-asset.js";
import { browserShellRetirementSource } from "../pwa/retire-build.js";
import { novncRequestPath } from "../screen-proxy.js";
import { apiRequestPath, proxyApiRequest, proxyDeviceUpgrade, rejectUpgrade } from "./proxy.js";
import type { Middleware, UpgradeHandler } from "./screen.js";
import { attachNovncProxy } from "./screen.js";

export interface GatewayOptions {
  root: string;
  api: string;
  screenSecret: string;
  allowedHosts: readonly string[];
  desktopStackToken?: string;
  imageTag?: string;
  scriptSources?: string;
  connectSources?: string;
  assetDelayMs?: number;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const gatewayLog = createServiceLogger({ service: "orkbot-web" });

function privateToken(expected: string | undefined, value: string | string[] | undefined) {
  if (!expected || typeof value !== "string") return false;
  const a = Buffer.from(expected),
    b = Buffer.from(value);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Resolve both lexical traversal and filesystem links before opening public assets. */
function publicFile(root: string, file: string): string | null {
  try {
    const canonical = realpathSync(file);
    const boundary = realpathSync(root);
    return canonical.startsWith(`${boundary}${path.sep}`) && statSync(canonical).isFile()
      ? canonical
      : null;
  } catch {
    return null;
  }
}

function staticPath(root: string, pathname: string): string | null {
  try {
    const decoded = decodeURIComponent(pathname);
    if (
      decoded.includes("\\") ||
      decoded.includes("\0") ||
      decoded.split("/").some((part) => part.startsWith("."))
    )
      return null;
    const file = path.resolve(root, `.${decoded}`);
    if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) return null;
    return publicFile(root, file);
  } catch {
    return null;
  }
}

function notFound(res: ServerResponse) {
  res.writeHead(404, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, immutable: boolean) {
  const metadata = statSync(file);
  res.setHeader("content-type", MIME[path.extname(file)] ?? "application/octet-stream");
  res.setHeader("content-length", metadata.size);
  res.setHeader("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(file).once("error", () => res.destroy());
  res.once("close", () => stream.destroy());
  stream.pipe(res);
}

/** A production HTTP edge for native clients and the small browser authorization surface. */
export function createGateway(options: GatewayOptions) {
  const target = new URL(options.api);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  )
    throw new Error("API_PROXY_TARGET must be an HTTP origin");
  const root = path.resolve(options.root);
  const dist = path.join(root, "dist");
  const assets = path.join(dist, "assets");
  const appPolicy = appContentSecurityPolicy({
    scriptSrc: parseContentSecuritySources("ORKBOT_CSP_SCRIPT_SRC", options.scriptSources),
    connectSrc: parseContentSecuritySources("ORKBOT_CSP_CONNECT_SRC", options.connectSources),
  });
  let archive: string | null = null;
  try {
    archive = archiveAssets({
      assetsDir: assets,
      archiveDir: path.join(root, ASSET_ARCHIVE_DIR),
      buildId: readFileSync(path.join(dist, "build-id"), "utf8").trim(),
      now: Date.now(),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    gatewayLog.warn("web.asset_archive_failed", {
      "error.code": typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN",
    });
  }
  const missing = missingAssetMiddleware(assets, "/assets/", archive, (file) =>
    Boolean(publicFile(assets, file) || (archive && publicFile(archive, file))),
  );
  let screen: Middleware = (_req, _res, next) => next();
  let screenUpgrade: UpgradeHandler = (_req, socket) => socket.destroy();
  attachNovncProxy(
    {
      middlewares: {
        use: (handler) => {
          screen = handler;
        },
      },
      httpServer: {
        on: (_event, handler) => {
          screenUpgrade = handler;
        },
      },
    },
    options.screenSecret,
    options.api,
  );

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!hostAllowed(req.headers.host, options.allowedHosts)) {
      res.writeHead(403, { "cache-control": "no-store" });
      res.end("Forbidden");
      return;
    }
    const pathname = req.url?.split("?", 1)[0] ?? "/";
    if (!pathname.startsWith("/") || pathname.startsWith("//")) {
      notFound(res);
      return;
    }
    res.setHeader("x-content-type-options", "nosniff");
    if (pathname !== COMPUTER_SCREEN_RUNTIME_PATH) res.setHeader("x-frame-options", "SAMEORIGIN");
    const policy = contentSecurityPolicyFor(pathname, appPolicy, wuyingScreenPolicy);
    if (policy) {
      res.setHeader("content-security-policy", policy);
      res.setHeader("reporting-endpoints", CSP_REPORTING_ENDPOINTS);
    }
    if (pathname.startsWith("/p/")) {
      res.setHeader("x-robots-tag", "noindex, nofollow");
      res.setHeader("referrer-policy", "no-referrer");
    }
    if (pathname === "/.well-known/orkbot-desktop-stack") {
      if (!privateToken(options.desktopStackToken, req.headers["x-orkbot-desktop-stack-token"])) {
        notFound(res);
        return;
      }
      res.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ ok: true, imageTag: options.imageTag ?? "edge" }));
      return;
    }
    if (apiRequestPath(pathname)) {
      proxyApiRequest(req, res, target);
      return;
    }
    if (novncRequestPath(req.url)) {
      await screen(req, res, () => notFound(res));
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      notFound(res);
      return;
    }
    if (pathname === "/sw.js") {
      res.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/javascript; charset=utf-8",
      });
      res.end(req.method === "HEAD" ? undefined : browserShellRetirementSource());
      return;
    }
    if (options.assetDelayMs && options.assetDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, options.assetDelayMs));
    if (res.destroyed) return;
    let continueStatic = false;
    missing(req, res, () => {
      continueStatic = true;
    });
    if (!continueStatic) return;
    const file = staticPath(dist, pathname);
    if (file) {
      sendFile(req, res, file, pathname.startsWith("/assets/"));
      return;
    }
    // Documents in embedded runtimes never fall through to the application shell.
    if (
      pathname.startsWith("/computer-screen/") ||
      path.posix.extname(pathname) ||
      pathname.includes("%") ||
      pathname.includes("\\") ||
      pathname.split("/").includes("..")
    ) {
      notFound(res);
      return;
    }
    const shell = publicFile(dist, path.join(dist, "index.html"));
    if (!shell) {
      notFound(res);
      return;
    }
    sendFile(req, res, shell, false);
  };
  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "cache-control": "no-store" });
        res.end("Gateway unavailable");
      } else res.destroy();
    });
  });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    if (!hostAllowed(req.headers.host, options.allowedHosts)) {
      rejectUpgrade(socket, 403);
      return;
    }
    if (novncRequestPath(req.url)) {
      void Promise.resolve(screenUpgrade(req, socket, head)).catch(() => socket.destroy());
      return;
    }
    proxyDeviceUpgrade(req, socket, head, target);
  });
  const sockets = new Set<Socket>();
  let drained = () => {};
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      drained();
    });
  });
  let closing: Promise<void> | undefined;
  return Object.assign(server, {
    shutdown(drainMs = 5_000): Promise<void> {
      closing ??= new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          drained = () => {};
          resolve();
        };
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
          finish();
        }, drainMs);
        let closed = false;
        drained = () => {
          if (closed && sockets.size === 0) finish();
        };
        server.close(() => {
          closed = true;
          drained();
        });
      });
      return closing;
    },
  });
}
