// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { describe, expect, it, vi } from "vitest";
import { secureFetch } from "./mcp-transport.js";
import { createPrivateNetworkFetch, createSafeRemoteFetch } from "./remote-mcp.js";
import { createSerenityPrivateLanFetch, probeSerenity } from "./serenity-client.js";

async function withProxy(
  run: (state: {
    proxied: string[];
    hosts: string[];
    authorization: string[];
    servernames: string[];
    port: number;
    rejectProxy(): void;
    proxyUrl: string;
  }) => Promise<void>,
  tls = false,
) {
  const proxied: string[] = [],
    hosts: string[] = [],
    authorization: string[] = [],
    servernames: string[] = [];
  const sockets = new Set<Socket>();
  const target = tls
    ? createTlsServer({
        SNICallback(servername, callback) {
          servernames.push(servername);
          callback(new Error("synthetic TLS handshake rejection"));
        },
      })
    : createServer(async (request, response) => {
        hosts.push(request.headers.host ?? "");
        authorization.push(request.headers.authorization ?? "");
        if (request.url === "/mcp") {
          if (request.method !== "POST") {
            response.writeHead(405).end();
            return;
          }
          let body = "";
          for await (const chunk of request) body += String(chunk);
          const message = JSON.parse(body);
          const result =
            message.method === "initialize"
              ? {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "fixture", version: "1" },
                }
              : message.method === "tools/list"
                ? { tools: [{ name: "recall", inputSchema: { type: "object" } }] }
                : undefined;
          if (!result) {
            response.writeHead(202).end();
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
          return;
        }
        response.end("ok");
      });
  if (tls) target.on("tlsClientError", () => {});
  let reject = false;
  const proxy = createServer((_request, response) => {
    response.writeHead(405).end();
  });
  proxy.on("connect", (request, client) => {
    proxied.push(request.url ?? "");
    if (reject) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = new Socket();
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    upstream.connect((target.address() as AddressInfo).port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(client).pipe(upstream);
    });
  });
  for (const server of [target, proxy])
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
    });
  await Promise.all(
    [target, proxy].map(
      (server) => new Promise<void>((done) => server.listen(0, "127.0.0.1", done)),
    ),
  );
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"])
    vi.stubEnv(name, proxyUrl);
  for (const name of ["NO_PROXY", "no_proxy"]) vi.stubEnv(name, "");
  try {
    await run({
      proxied,
      hosts,
      authorization,
      servernames,
      port: (target.address() as AddressInfo).port,
      rejectProxy: () => {
        reject = true;
      },
      proxyUrl,
    });
  } finally {
    vi.unstubAllEnvs();
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [target, proxy].map((server) => new Promise<void>((done) => server.close(() => done()))),
    );
  }
}
const privateDns = async () => [{ address: "127.0.0.1", family: 4 as const }];
const signal = () => AbortSignal.timeout(700);

describe("guarded connector HTTP proxies", () => {
  it("completes an actual memory MCP handshake through the proxy for a literal endpoint", async () => {
    await withProxy(async ({ proxied, authorization, port }) => {
      const result = await probeSerenity(
        { endpoint: `http://127.0.0.1:${port}/mcp`, token: "fake-memory-token" },
        signal(),
      );
      expect(result).toEqual({ ok: true, value: undefined });
      expect(proxied.length).toBeGreaterThan(0);
      expect(proxied.every((authority) => authority === `127.0.0.1:${port}`)).toBe(true);
      expect(authorization.every((value) => value === "Bearer fake-memory-token")).toBe(true);
    });
  });
  it.each([
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "169.254.2.3", family: 4 }],
    [
      { address: "127.0.0.1", family: 4 },
      { address: "203.0.113.10", family: 4 },
    ],
  ])(
    "refuses metadata, link-local and mixed DNS sets before a proxy sees them: %j",
    async (...addresses) => {
      await withProxy(async ({ proxied, hosts }) => {
        const fetch = createSafeRemoteFetch(undefined, async () => addresses, {
          allowPrivateEndpoint: true,
        });
        try {
          await expect(
            fetch("https://service.example.test/data", { signal: signal() }),
          ).rejects.toThrow();
          expect(proxied).toEqual([]);
          expect(hosts).toEqual([]);
        } finally {
          await fetch.close();
        }
      });
    },
  );

  it("keeps owner-gated memory DNS pinned across proxy CONNECT and TLS", async () => {
    await withProxy(async ({ proxied, servernames, port }) => {
      const resolve = vi
        .fn()
        .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
        .mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
      const fetch = createSerenityPrivateLanFetch(undefined, resolve);
      await expect(
        fetch(`https://memory.example.test:${port}/mcp`, { signal: signal() }),
      ).rejects.toThrow();
      expect(resolve).toHaveBeenCalledOnce();
      expect(proxied).toEqual([`127.0.0.1:${port}`]);
      expect(servernames).toEqual(["memory.example.test"]);
    }, true);
  });

  it("refuses unsupported proxies without exposing their credentials", async () => {
    await withProxy(async ({ proxyUrl, proxied }) => {
      for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"])
        vi.stubEnv(name, proxyUrl.replace("http://", "socks5://fake-user:fake-proxy-secret@"));
      expect(() => createSafeRemoteFetch()).toThrow("Only HTTP proxies are supported");
      expect(() => createPrivateNetworkFetch()).toThrow("Only HTTP proxies are supported");
      const fetch = createSerenityPrivateLanFetch(undefined, privateDns);
      await expect(fetch("https://memory.example.test/mcp", { signal: signal() })).rejects.toThrow(
        "Only HTTP proxies are supported",
      );
      expect(proxied).toEqual([]);
    });
  });

  it.each(["remote", "private", "memory"])(
    "tunnels %s fetch to a checked IP while retaining Host",
    async (kind) => {
      await withProxy(async ({ proxied, hosts, port }) => {
        const fetch =
          kind === "remote"
            ? createSafeRemoteFetch(undefined, privateDns, { allowPrivateEndpoint: true })
            : kind === "private"
              ? createPrivateNetworkFetch(undefined, privateDns)
              : createSerenityPrivateLanFetch(undefined, privateDns);
        try {
          expect(
            await (
              await fetch(`http://service.example.test:${port}/data`, { signal: signal() })
            ).text(),
          ).toBe("ok");
          expect(proxied).toEqual([`127.0.0.1:${port}`]);
          expect(hosts).toEqual([`service.example.test:${port}`]);
        } finally {
          await fetch.close();
        }
      });
    },
  );
  it("preserves the original HTTPS SNI while CONNECT uses the checked IP", async () => {
    await withProxy(async ({ proxied, servernames, port }) => {
      const fetch = createSafeRemoteFetch(undefined, privateDns, { allowPrivateEndpoint: true });
      try {
        await expect(
          fetch(`https://service.example.test:${port}/data`, { signal: signal() }),
        ).rejects.toThrow();
        expect(proxied).toEqual([`127.0.0.1:${port}`]);
        expect(servernames).toEqual(["service.example.test"]);
      } finally {
        await fetch.close();
      }
    }, true);
  });
  it.each([".example.test", "service.example.test:PORT", "*"])(
    "uses standard NO_PROXY matching %s",
    async (pattern) => {
      await withProxy(async ({ proxied, hosts, port }) => {
        for (const name of ["NO_PROXY", "no_proxy"])
          vi.stubEnv(name, pattern.replace("PORT", String(port)));
        const fetch = createSafeRemoteFetch(
          undefined,
          async () => [{ address: "127.0.0.1", family: 4 }],
          { allowPrivateEndpoint: true },
        );
        try {
          expect(
            await (
              await fetch(`http://service.example.test:${port}/data`, { signal: signal() })
            ).text(),
          ).toBe("ok");
          expect(proxied).toEqual([]);
          expect(hosts).toEqual([`service.example.test:${port}`]);
        } finally {
          await fetch.close();
        }
      });
    },
  );
  it("does not treat a NO_PROXY rule for another port as a match", async () => {
    await withProxy(async ({ proxied, port }) => {
      for (const name of ["NO_PROXY", "no_proxy"])
        vi.stubEnv(name, `service.example.test:${port + 1}`);
      const fetch = createSafeRemoteFetch(
        undefined,
        async () => [{ address: "127.0.0.1", family: 4 }],
        { allowPrivateEndpoint: true },
      );
      try {
        expect(
          await (
            await fetch(`http://service.example.test:${port}/data`, { signal: signal() })
          ).text(),
        ).toBe("ok");
        expect(proxied).toEqual([`127.0.0.1:${port}`]);
      } finally {
        await fetch.close();
      }
    });
  });
  it("keeps local MCP credentials and origin policy while using the guarded proxy", async () => {
    await withProxy(async ({ proxied, authorization, port }) => {
      const url = new URL(`http://127.0.0.1:${port}/data`);
      const fetch = secureFetch(
        url,
        { allowPrivateEndpoint: true, allowHttpLocalhost: true, allowLocalHttpCredentials: true },
        { headers: { authorization: "Bearer fake-credential" } },
      );
      try {
        expect(
          await (
            await fetch(url, {
              signal: signal(),
              headers: { authorization: "Bearer fake-credential" },
            })
          ).text(),
        ).toBe("ok");
        expect(proxied).toEqual([`127.0.0.1:${port}`]);
        expect(authorization).toEqual(["Bearer fake-credential"]);
      } finally {
        await fetch.close();
      }
    });
  });
  it("refuses DNS rebinding before sending CONNECT", async () => {
    await withProxy(async ({ proxied }) => {
      let calls = 0;
      const fetch = createSafeRemoteFetch(undefined, async () => [
        { address: calls++ ? "127.0.0.1" : "203.0.113.10", family: 4 },
      ]);
      try {
        await expect(
          fetch("https://service.example.test/data", { signal: signal() }),
        ).rejects.toThrow();
        expect(proxied).toEqual([]);
      } finally {
        await fetch.close();
      }
    });
  });
  it("keeps localhost restricted to loopback answers during CONNECT", async () => {
    await withProxy(async ({ proxied, port }) => {
      const fetch = createSafeRemoteFetch(
        undefined,
        async () => [{ address: "10.2.3.4", family: 4 }],
        { allowPrivateEndpoint: true },
      );
      try {
        await expect(
          fetch(`http://localhost:${port}/data`, { signal: signal() }),
        ).rejects.toThrow();
        expect(proxied).toEqual([]);
      } finally {
        await fetch.close();
      }
    });
  });
  it("never falls back direct or exposes proxy credentials on proxy failure", async () => {
    await withProxy(async ({ rejectProxy, proxyUrl, hosts, proxied, port }) => {
      rejectProxy();
      const configured = proxyUrl.replace("http://", "http://fake-user:fake-proxy-secret@");
      for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"])
        vi.stubEnv(name, configured);
      const fetch = createSafeRemoteFetch(
        undefined,
        async () => [{ address: "127.0.0.1", family: 4 }],
        { allowPrivateEndpoint: true },
      );
      try {
        let failure: unknown;
        try {
          await fetch(`http://service.example.test:${port}/data`, { signal: signal() });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).not.toContain("fake-proxy-secret");
        expect(hosts).toEqual([]);
        expect(proxied.length).toBeGreaterThan(0);
      } finally {
        await fetch.close();
      }
    });
  });
});
