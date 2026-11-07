// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders, RequestListener, Server } from "node:http";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addScreenProxyCapability,
  openScreenCapability,
} from "@orkbot/core/node/screen-capability";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "./server.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function listen(server: Server, host = "127.0.0.1") {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function api(handler: RequestListener = (_req, res) => res.end("api"), host?: string) {
  const server = http.createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await listen(server, host);
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return { server, origin: `http://${host === "::1" ? "[::1]" : "127.0.0.1"}:${port}` };
}

async function gateway(target?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "ork-gateway-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist/assets"), { recursive: true });
  await mkdir(path.join(root, "dist/computer-screen/sdk/ASP"), { recursive: true });
  await writeFile(
    path.join(root, "dist/index.html"),
    '<!doctype html><meta name="orkbot-native-renderer" content="bundled-v1"><div id="root">handoff</div>',
  );
  await writeFile(path.join(root, "dist/assets/current.js"), "current asset");
  await writeFile(path.join(root, "dist/build-id"), "20261107000000\n");
  await writeFile(path.join(root, "dist/html-viewer.html"), "html viewer");
  await writeFile(path.join(root, "dist/computer-screen/screen.html"), "screen document");
  await writeFile(path.join(root, "dist/computer-screen/sdk/ASP/container.html"), "screen runtime");
  const upstream = target ?? (await api()).origin;
  const server = createGateway({
    root,
    api: upstream,
    screenSecret: "fake-screen-proxy-secret-0123456789",
    allowedHosts: ["app.example.test"],
    desktopStackToken: "fake-stack-proof",
    imageTag: "fixture-tag",
  });
  const port = await listen(server);
  cleanup.push(() => server.shutdown(0));
  return { server, root, port };
}

function request(
  port: number,
  pathname: string,
  options: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {},
) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: pathname,
          method: options.method ?? "GET",
          headers: { host: "app.example.test", ...options.headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.once("end", () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
          res.once("error", reject);
        },
      );
      req.once("error", reject);
      req.end(options.body);
    },
  );
}

describe("production web gateway", () => {
  it("serves native bootstrap and protocol pages while forwarding the exact API callback", async () => {
    const upstream = await api((req, res) => res.end(req.url));
    const { port } = await gateway(upstream.origin);
    for (const route of [
      "/",
      "/app",
      "/sso/callback",
      "/integrations/callback",
      "/mcp/oauth/callback",
      "/messaging/slack/callback",
      "/callback-other",
    ]) {
      const page = await request(port, route);
      expect(page.status).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.body).toContain('name="orkbot-native-renderer" content="bundled-v1"');
      expect(page.headers["content-security-policy"]).toContain("frame-src 'self'");
    }
    expect((await request(port, "/callback?code=fake&state=fixture")).body).toBe(
      "/callback?code=fake&state=fixture",
    );
    expect((await request(port, "/.well-known/apple-app-site-association")).body).toBe(
      "/.well-known/apple-app-site-association",
    );
  });

  it("preserves distinct viewer policies, retirement worker and build metadata", async () => {
    const { port } = await gateway();
    const viewer = await request(port, "/html-viewer.html");
    expect(viewer.body).toBe("html viewer");
    expect(viewer.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    const runtime = await request(port, "/computer-screen/sdk/ASP/container.html");
    expect(runtime.headers["x-frame-options"]).toBeUndefined();
    expect(runtime.headers["content-security-policy"]).toContain(
      "sandbox allow-scripts allow-pointer-lock",
    );
    expect(runtime.headers["content-security-policy"]).not.toContain("frame-ancestors");
    expect((await request(port, "/computer-screen/missing.html")).status).toBe(404);
    const worker = await request(port, "/sw.js");
    expect(worker.headers["cache-control"]).toBe("no-store");
    expect(worker.body).toContain("self.registration.unregister()");
    expect((await request(port, "/build-id")).body).toBe("20261107000000\n");
  });

  it("keeps the desktop instance probe private and uncached", async () => {
    const { port } = await gateway();
    expect((await request(port, "/.well-known/orkbot-desktop-stack")).status).toBe(404);
    const probe = await request(port, "/.well-known/orkbot-desktop-stack", {
      headers: { "x-orkbot-desktop-stack-token": "fake-stack-proof" },
    });
    expect(probe.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(probe.body)).toEqual({ ok: true, imageTag: "fixture-tag" });
  });

  it("rejects untrusted hosts before static, API or screen authorization work", async () => {
    let upstreamRequests = 0;
    const upstream = await api((_req, res) => {
      upstreamRequests++;
      res.end();
    });
    const { port } = await gateway(upstream.origin);
    for (const route of ["/", "/api/session", "/novnc/session/view/invalid/vnc.html"]) {
      expect((await request(port, route, { headers: { host: "untrusted.example" } })).status).toBe(
        403,
      );
    }
    expect(upstreamRequests).toBe(0);
  });

  it("returns missing assets without SPA fallback and prevents traversal or linked file escape", async () => {
    const { root, port } = await gateway();
    const outside = path.join(root, "private-token");
    await writeFile(outside, "private sentinel");
    await symlink(outside, path.join(root, "dist/assets/linked.js"));
    await symlink(outside, path.join(root, "dist/linked.txt"));
    for (const route of [
      "/assets/missing.js",
      "/assets/linked.js",
      "/linked.txt",
      "/assets/%2e%2e/%2e%2e/private-token",
      "/%2e%2e/private-token",
      "/../private-token",
      "/assets/%00.js",
      "/assets/%ZZ.js",
    ]) {
      const response = await request(port, route);
      expect({ route, status: response.status }).toEqual({ route, status: 404 });
      expect(response.body).not.toContain("private sentinel");
      expect(response.body).not.toContain("handoff");
    }
  });

  it("serves immutable current and archived assets with HEAD support and rejects archive links", async () => {
    const { root, server, port } = await gateway();
    const current = await request(port, "/assets/current.js", { method: "HEAD" });
    expect(current.status).toBe(200);
    expect(current.body).toBe("");
    expect(current.headers["cache-control"]).toContain("immutable");
    await server.shutdown(0);
    await mkdir(path.join(root, "asset-archive/assets"), { recursive: true });
    await writeFile(path.join(root, "asset-archive/assets/old.js"), "old asset");
    await writeFile(path.join(root, "private-token"), "private sentinel");
    await symlink(
      path.join(root, "private-token"),
      path.join(root, "asset-archive/assets/linked.js"),
    );
    const replacement = createGateway({
      root,
      api: (await api()).origin,
      screenSecret: "fake-secret",
      allowedHosts: ["app.example.test"],
    });
    const replacementPort = await listen(replacement);
    cleanup.push(() => replacement.shutdown(0));
    const archived = await request(replacementPort, "/assets/old.js");
    expect(archived.body).toBe("old asset");
    expect(archived.headers["cache-control"]).toContain("immutable");
    expect((await request(replacementPort, "/assets/linked.js")).status).toBe(404);
  });

  it("streams authenticated uploads and preserves cookies and API CORS headers", async () => {
    const upstream = await api(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      res.writeHead(200, {
        "set-cookie": ["first=fake; HttpOnly", "second=fake; HttpOnly"],
        "access-control-allow-origin": "https://app.example.test",
        "access-control-allow-credentials": "true",
      });
      res.end(JSON.stringify({ headers: req.headers, body: Buffer.concat(chunks).toString() }));
    });
    const { port } = await gateway(upstream.origin);
    const response = await request(port, "/api/upload", {
      method: "POST",
      headers: {
        cookie: "session=fake",
        authorization: "Bearer fake-token",
        origin: "https://app.example.test",
        "x-forwarded-for": "203.0.113.9",
        "content-type": "text/plain",
      },
      body: "uploaded content",
    });
    expect(response.headers["set-cookie"]).toEqual([
      "first=fake; HttpOnly",
      "second=fake; HttpOnly",
    ]);
    expect(response.headers["access-control-allow-origin"]).toBe("https://app.example.test");
    expect(JSON.parse(response.body)).toMatchObject({
      body: "uploaded content",
      headers: {
        host: new URL(upstream.origin).host,
        cookie: "session=fake",
        authorization: "Bearer fake-token",
        origin: "https://app.example.test",
        "x-forwarded-for": "203.0.113.9, 127.0.0.1",
      },
    });
  });

  it("delivers SSE before the upstream ends and aborts upstream work when the client leaves", async () => {
    let aborted!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const upstream = await api((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      res.once("close", aborted);
    });
    const { port } = await gateway(upstream.origin);
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/rpc/events" }, (res) => {
        res.once("data", (chunk) => {
          expect(chunk.toString()).toBe("data: first\n\n");
          req.destroy();
          resolve();
        });
      });
      req.once("error", reject);
    });
    await upstreamClosed;
  });

  it("cancels a partially uploaded request when the client disconnects", async () => {
    let start!: () => void;
    let close!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const upstream = await api((req, res) => {
      if (req.method !== "POST") {
        res.end("healthy");
        return;
      }
      req.once("data", start);
      req.once("close", close);
      req.once("error", () => {});
    });
    const { port } = await gateway(upstream.origin);
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/api/upload",
      method: "POST",
      headers: { "content-length": "100" },
    });
    req.once("error", () => {});
    req.write("partial");
    await started;
    req.destroy();
    await closed;
    expect((await request(port, "/rpc/health")).body).toBe("healthy");
  });

  it("returns a bounded upstream failure without leaking connection details", async () => {
    const upstream = await api();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    const { port } = await gateway(upstream.origin);
    const response = await request(port, "/api/session");
    expect(response.status).toBe(502);
    expect(response.body).toBe("Server unavailable");
  });

  it("drains active streams within the shutdown deadline", async () => {
    const upstream = await api((_req, res) => {
      res.writeHead(200);
      res.write("stream");
    });
    const { server, port } = await gateway(upstream.origin);
    const req = http.get({ host: "127.0.0.1", port, path: "/rpc/events" });
    await new Promise<void>((resolve) =>
      req.once("response", (res) => {
        res.once("data", () => resolve());
      }),
    );
    const start = Date.now();
    await server.shutdown(10);
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(server.listening).toBe(false);
    req.destroy();
  });

  it("forwards requests to an IPv6 loopback API", async () => {
    const upstream = await api((_req, res) => res.end("ipv6 api"), "::1");
    const { port } = await gateway(upstream.origin);
    expect((await request(port, "/rpc/health")).body).toBe("ipv6 api");
  });

  it("ends a screen asset response when its upstream resets after the body starts", async () => {
    const secret = "fake-screen-proxy-secret-0123456789";
    let screenResponse: http.ServerResponse | undefined;
    const computer = await api((_req, res) => {
      screenResponse = res;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "100" });
      res.write("partial-body");
    });
    const authority = await api(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const { path: screenPath } = JSON.parse(Buffer.concat(chunks).toString());
      const capability = openScreenCapability(screenPath, secret);
      if (!capability) {
        res.writeHead(403).end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(capability.target));
    });
    const { port } = await gateway(authority.origin);
    const screen = new URL(
      addScreenProxyCapability(
        `${computer.origin}/binary.bin`,
        secret,
        `http://127.0.0.1:${port}`,
        {
          botId: "bot",
          computerId: "computer",
          botGeneration: 0,
          computerGeneration: 0,
          controlLeaseId: null,
        },
      ),
    );
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: screen.pathname + screen.search },
        (res) => {
          res.once("data", (chunk) => {
            expect(chunk.toString()).toBe("partial-body");
            screenResponse!.destroy();
          });
          res.once("aborted", resolve);
          res.once("error", () => {});
          res.once("end", () =>
            reject(new Error("A truncated screen asset must not finish successfully")),
          );
        },
      );
      req.once("error", reject);
      req.setTimeout(2_000, () =>
        req.destroy(new Error("The screen response remained open after an upstream reset")),
      );
    });
  });
});
