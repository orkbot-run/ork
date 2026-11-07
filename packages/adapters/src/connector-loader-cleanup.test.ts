// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareGraphqlInstall } from "./graphql-connectors.js";
import { prepareApiInstall } from "./installed-connectors.js";
import type * as RemoteMcp from "./remote-mcp.js";

const lifecycle = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock("./remote-mcp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteMcp>();
  return {
    ...actual,
    createSafeRemoteFetch: (...args: Parameters<typeof actual.createSafeRemoteFetch>) => {
      const fetch = actual.createSafeRemoteFetch(...args);
      const close = fetch.close;
      fetch.close = () => {
        lifecycle.events.push("close");
        return close();
      };
      return fetch;
    },
  };
});

const loaders = [
  {
    name: "OpenAPI",
    run: prepareApiInstall,
    config: { openApi: true },
    http: "OpenAPI document returned HTTP",
    size: "OpenAPI document is too large",
  },
  {
    name: "GraphQL",
    run: prepareGraphqlInstall,
    config: {},
    http: "GraphQL introspection returned HTTP",
    size: "GraphQL introspection response is too large",
  },
];

beforeEach(() => {
  lifecycle.events.length = 0;
});

describe.each(loaders)("$name response cleanup", ({ run, config, http, size }) => {
  async function load(response: Response) {
    return run({
      source: "https://schema.example.test/document",
      config,
      remote: {
        fetch: async () => response,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      },
    });
  }
  function response(
    status: number,
    headers: Record<string, string> = {},
    cancelFailure?: "throw" | "reject",
  ) {
    const cancel = vi.fn(() => {
      lifecycle.events.push("cancel");
      if (cancelFailure === "throw") throw new Error("synthetic cancellation failure");
      if (cancelFailure === "reject")
        return Promise.reject(new Error("synthetic cancellation failure"));
    });
    return {
      value: new Response(new ReadableStream<Uint8Array>({ cancel }), { status, headers }),
      cancel,
    };
  }
  it.each([401, 429, 503])("cancels HTTP %s before closing its dispatcher", async (status) => {
    const body = response(status);
    await expect(load(body.value)).rejects.toThrow(`${http} ${status}`);
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(lifecycle.events).toEqual(["cancel", "close"]);
  });
  it("cancels a declared oversized body before closing its dispatcher", async () => {
    const body = response(200, { "content-length": "2000001" });
    await expect(load(body.value)).rejects.toThrow(size);
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(lifecycle.events).toEqual(["cancel", "close"]);
  });
  it.each(["throw", "reject"] as const)(
    "preserves the original error when cancellation can %s",
    async (failure) => {
      const body = response(503, {}, failure);
      await expect(load(body.value)).rejects.toThrow(`${http} 503`);
      expect(body.cancel).toHaveBeenCalledOnce();
      expect(lifecycle.events).toEqual(["cancel", "close"]);
    },
  );
  it("closes a bodyless HTTP error without changing it", async () => {
    await expect(load(new Response(null, { status: 503 }))).rejects.toThrow(`${http} 503`);
    expect(lifecycle.events).toEqual(["close"]);
  });
  it("cancels an unannounced stream overflow exactly once", async () => {
    const cancel = vi.fn(() => {
      lifecycle.events.push("cancel");
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2000001));
      },
      cancel,
    });
    await expect(load(new Response(body))).rejects.toThrow(size);
    expect(cancel).toHaveBeenCalledOnce();
    expect(lifecycle.events).toEqual(["cancel", "close"]);
  });
});
