// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { once } from "node:events";
import type { Server } from "node:http";
import { createServer, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { normalizeContext } from "@earendil-works/pi-ai";
import { Agent, Client, EnvHttpProxyAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localProvider } from "./pi-local-provider.js";
import { dispatcherFetch } from "./undici-fetch.js";

const servers: Server[] = [];
const sockets = new Set<Socket>();
const dispatchers = new Set<Agent | EnvHttpProxyAgent>();
const context = normalizeContext({
  messages: [{ role: "user", content: "Continue", timestamp: 0 }],
});
const completion = `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test endpoint");
  return `http://127.0.0.1:${address.port}`;
}

async function fixture() {
  for (const name of [
    "http_proxy",
    "HTTP_PROXY",
    "https_proxy",
    "HTTPS_PROXY",
    "no_proxy",
    "NO_PROXY",
    "NODE_USE_ENV_PROXY",
    "NODE_OPTIONS",
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("ORKBOT_LOCAL_MODELS", "fixture");
  let requests = 0;
  const origin = await listen(
    createServer((request, response) => {
      request.resume();
      requests++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(completion);
    }),
  );
  vi.stubEnv("ORKBOT_LOCAL_MODELS_URL", `${origin}/v1`);
  const provider = localProvider()!;
  const model = provider.getModels()[0]!;
  return { provider, model, origin, requests: () => requests };
}

function trackDispatchers() {
  for (const prototype of [Agent.prototype, EnvHttpProxyAgent.prototype]) {
    const original = prototype.dispatch;
    vi.spyOn(prototype, "dispatch").mockImplementation(function (
      this: Agent | EnvHttpProxyAgent,
      options,
      handler,
    ) {
      dispatchers.add(this);
      return original.call(this, options, handler);
    });
  }
}

/** Inspect the actual undici Client reached on the wire, rather than a mocked constructor. */
function clientTimeouts(client: Client) {
  return Object.fromEntries(
    Object.getOwnPropertySymbols(client)
      .filter(
        (symbol) =>
          symbol.description === "headers timeout" || symbol.description === "body timeout",
      )
      .map((symbol) => [symbol.description, Reflect.get(client, symbol)]),
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all([...dispatchers].map((dispatcher) => dispatcher.destroy()));
  dispatchers.clear();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  vi.unstubAllEnvs();
});

describe("local model streaming transport", () => {
  it("uses the same dedicated pool with disabled client timeouts for both stream entry points", async () => {
    const { provider, model, requests } = await fixture();
    trackDispatchers();
    const clientDispatch = vi.spyOn(Client.prototype, "dispatch");
    // Proxy variables alone must not route an otherwise trusted local server through a proxy.
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    for (const stream of [provider.stream.bind(provider), provider.streamSimple.bind(provider)]) {
      const result = await stream(model, context, { apiKey: "local", maxRetries: 0 }).result();
      expect(result.stopReason).toBe("stop");
      expect(result.content).toContainEqual({ type: "text", text: "Ready" });
    }
    expect(requests()).toBe(2);
    expect(dispatchers.size).toBe(1);
    expect([...dispatchers][0]).toBeInstanceOf(Agent);
    expect(clientDispatch).toHaveBeenCalled();
    for (const client of clientDispatch.mock.instances) {
      expect(clientTimeouts(client as Client)).toEqual({ "headers timeout": 0, "body timeout": 0 });
    }
  });

  it("preserves a caller fetch and forwards cancellation through it", async () => {
    const { provider, model } = await fixture();
    const controller = new AbortController();
    let forwardedSignal: AbortSignal | null | undefined;
    const customFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const dispatcher = (init as RequestInit & { dispatcher: Agent }).dispatcher;
      dispatchers.add(dispatcher);
      forwardedSignal = init?.signal;
      controller.abort(new Error("operator cancelled"));
      return dispatcherFetch(input, init);
    });
    const result = await provider
      .streamSimple(model, context, {
        apiKey: "local",
        fetch: customFetch,
        signal: controller.signal,
        maxRetries: 0,
      })
      .result();
    expect(customFetch).toHaveBeenCalledOnce();
    expect(forwardedSignal?.aborted).toBe(true);
    expect(result.stopReason).toBe("aborted");
  });

  it.each(["env", "NODE_OPTIONS", "execArgv"])(
    "honours Node proxy opt-in via %s on the wire",
    async (mode) => {
      const { provider, model, origin, requests } = await fixture();
      const upstreamPort = new URL(origin).port;
      let proxyRequests = 0;
      let proxyTarget: string | undefined;
      const proxy = createServer((request, response) => {
        proxyRequests++;
        proxyTarget = request.url;
        // This fixture forwards only to its own loopback server, regardless of the request target.
        const upstream = httpRequest(
          {
            hostname: "127.0.0.1",
            port: upstreamPort,
            path: "/v1/chat/completions",
            method: "POST",
            headers: { "content-type": "application/json" },
          },
          (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode!, upstreamResponse.headers);
            upstreamResponse.pipe(response);
          },
        );
        request.pipe(upstream);
        upstream.on("error", () => response.destroy());
      });
      vi.stubEnv("HTTP_PROXY", await listen(proxy));
      if (mode === "env") vi.stubEnv("NODE_USE_ENV_PROXY", "1");
      if (mode === "NODE_OPTIONS") vi.stubEnv("NODE_OPTIONS", "--use-env-proxy");
      if (mode === "execArgv")
        vi.spyOn(process, "execArgv", "get").mockReturnValue(["--use-env-proxy"]);
      trackDispatchers();
      const clientDispatch = vi.spyOn(Client.prototype, "dispatch");
      const result = await provider
        .streamSimple(model, context, { apiKey: "local", maxRetries: 0 })
        .result();
      expect(result.stopReason).toBe("stop");
      expect(requests()).toBe(1);
      expect(proxyRequests).toBe(1);
      expect(proxyTarget).toBe(`${origin}/v1/chat/completions`);
      expect([...dispatchers].some((dispatcher) => dispatcher instanceof EnvHttpProxyAgent)).toBe(
        true,
      );
      for (const client of clientDispatch.mock.instances) {
        expect(clientTimeouts(client as Client)).toEqual({
          "headers timeout": 0,
          "body timeout": 0,
        });
      }
    },
  );

  it.each(["NODE_OPTIONS", "execArgv"])(
    "allows %s to disable the environment proxy opt-in",
    async (mode) => {
      const { provider, model } = await fixture();
      vi.stubEnv("NODE_USE_ENV_PROXY", "1");
      vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
      vi.stubEnv("NODE_OPTIONS", "--use-env-proxy");
      if (mode === "NODE_OPTIONS") vi.stubEnv("NODE_OPTIONS", "--use-env-proxy --no-use-env-proxy");
      if (mode === "execArgv")
        vi.spyOn(process, "execArgv", "get").mockReturnValue(["--no-use-env-proxy"]);
      trackDispatchers();
      const result = await provider
        .streamSimple(model, context, { apiKey: "local", maxRetries: 0 })
        .result();
      expect(result.stopReason).toBe("stop");
      expect([...dispatchers].some((dispatcher) => dispatcher instanceof EnvHttpProxyAgent)).toBe(
        false,
      );
    },
  );

  it("respects NO_PROXY for local endpoints when Node proxy support is enabled", async () => {
    const { provider, model } = await fixture();
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    trackDispatchers();
    const result = await provider
      .stream(model, context, { apiKey: "local", maxRetries: 0 })
      .result();
    expect(result.stopReason).toBe("stop");
    expect([...dispatchers].some((dispatcher) => dispatcher instanceof EnvHttpProxyAgent)).toBe(
      true,
    );
  });
});
