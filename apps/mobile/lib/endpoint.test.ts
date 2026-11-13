// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited endpoint tests are preserved. Native initialization checks are Ork additions.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_PROBE_TIMEOUT_MS,
  apiBaseWarning,
  defaultApiBase,
  displayApiHost,
  MAX_API_PROBE_RESPONSE_BYTES,
  normalizeApiBase,
  probeApiBase,
  serverInitializationRequired,
  usesCustomApiBase,
} from "./endpoint.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("normalizeApiBase", () => {
  it("trims, adds https, and keeps only the origin", () => {
    expect(normalizeApiBase("  app.example.com/rpc  ")).toEqual({
      ok: true,
      url: "https://app.example.com",
    });
    expect(normalizeApiBase("https://orkbot.example.com:8443/api/")).toEqual({
      ok: true,
      url: "https://orkbot.example.com:8443",
    });
    expect(normalizeApiBase("http://192.168.1.20:3100/")).toEqual({
      ok: true,
      url: "http://192.168.1.20:3100",
    });
    expect(normalizeApiBase("http://app.example.com")).toEqual({
      ok: false,
      error: "Public servers need https://",
    });
  });

  it("rejects empty, non-http, and malformed values", () => {
    expect(normalizeApiBase("")).toMatchObject({ ok: false });
    expect(normalizeApiBase("   ")).toMatchObject({ ok: false });
    expect(normalizeApiBase("javascript:alert(1)")).toMatchObject({ ok: false });
    expect(normalizeApiBase("ftp://files.example.com")).toMatchObject({ ok: false });
    expect(normalizeApiBase("http://")).toMatchObject({ ok: false });
  });

  it("strips credentials from the stored origin", () => {
    expect(normalizeApiBase("https://user:pass@app.example.com/rpc")).toEqual({
      ok: true,
      url: "https://app.example.com",
    });
  });
});

describe("display and warnings", () => {
  it("falls back to loopback when the compile-time endpoint is invalid", async () => {
    vi.stubEnv("EXPO_PUBLIC_API_URL", "ftp://files.example.com");
    vi.resetModules();
    const endpoint = await import("./endpoint.js");

    expect(endpoint.defaultApiBase()).toBe("http://127.0.0.1:3100");
    vi.unstubAllEnvs();
  });

  it("falls back to loopback when the compile-time endpoint is public HTTP", async () => {
    vi.stubEnv("EXPO_PUBLIC_API_URL", "http://app.example.com");
    vi.resetModules();
    const endpoint = await import("./endpoint.js");

    expect(endpoint.defaultApiBase()).toBe("http://127.0.0.1:3100");
    vi.unstubAllEnvs();
  });

  it("shows host and non-default port", () => {
    expect(displayApiHost("https://orkbot.example.com")).toBe("orkbot.example.com");
    expect(displayApiHost("http://10.0.0.8:3100")).toBe("10.0.0.8:3100");
  });

  it("warns on public http but not LAN or loopback", () => {
    expect(apiBaseWarning("https://app.example.com")).toBeNull();
    expect(apiBaseWarning("http://127.0.0.1:3100")).toBeNull();
    expect(apiBaseWarning("http://192.168.1.20:3100")).toBeNull();
    expect(apiBaseWarning("http://100.64.0.1:3100")).toBeNull();
    expect(apiBaseWarning("http://100.119.57.55:3100")).toBeNull();
    expect(apiBaseWarning("http://100.127.255.255:3100")).toBeNull();
    expect(apiBaseWarning("http://app.example.com")).toMatch(/https/i);
  });

  it("shares the desktop private-network rules for cleartext servers", () => {
    expect(apiBaseWarning("http://127.0.0.2:3100")).toBeNull();
    expect(apiBaseWarning("http://[fd00::1]:3100")).toBeNull();
    expect(apiBaseWarning("http://orkbot.localhost:3100")).toBeNull();
    expect(apiBaseWarning("http://169.254.169.254")).toMatch(/https/i);
    expect(apiBaseWarning("http://100.100.100.200")).toMatch(/https/i);
    expect(apiBaseWarning("http://[fe80::1]:3100")).toMatch(/https/i);
  });

  it("treats the compile-time default as not custom", () => {
    expect(usesCustomApiBase(defaultApiBase())).toBe(false);
    expect(usesCustomApiBase("https://orkbot.example.com")).toBe(true);
  });
});

describe("probeApiBase", () => {
  it("accepts a Ork /rpc/health response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ json: { ok: true, version: "0.1.0" } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(probeApiBase("https://app.example.com", fetchImpl)).resolves.toEqual({
      ok: true,
      url: "https://app.example.com",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.example.com/rpc/health",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-orkbot-protocol": "2" }),
      }),
    );
  });

  it("rejects a host that is up but is not Ork", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(probeApiBase("https://example.com", fetchImpl)).resolves.toMatchObject({
      ok: false,
    });
  });

  it("rejects an oversized health response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ json: { ok: true } }), {
          headers: { "content-length": String(MAX_API_PROBE_RESPONSE_BYTES + 1) },
        }),
    ) as unknown as typeof fetch;

    await expect(probeApiBase("https://app.example.com", fetchImpl)).resolves.toMatchObject({
      ok: false,
      error: "Could not reach that server",
    });
  });

  it("returns a failure when an injected fetch ignores the probe signal", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => undefined),
    );

    const pending = probeApiBase("https://app.example.com", fetchImpl as typeof fetch);
    await vi.advanceTimersByTimeAsync(API_PROBE_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: "Could not reach that server",
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("returns a failure when a health response body never settles", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ cancel })));

    const pending = probeApiBase("https://app.example.com", fetchImpl as typeof fetch);
    await vi.advanceTimersByTimeAsync(API_PROBE_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: "Could not reach that server",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("serverInitializationRequired", () => {
  const origin = "https://server.example.test";
  it.each([true, false])(
    "reads initialization state without any credential headers (%s)",
    async (required) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ required })));
      await expect(serverInitializationRequired(origin, request)).resolves.toBe(required);
      const [url, init] = request.mock.calls[0]!;
      expect(url).toBe(`${origin}/api/auth/native/initialization`);
      expect(init).toMatchObject({
        method: "GET",
        credentials: "omit",
        redirect: "error",
        signal: expect.any(AbortSignal),
      });
      expect(init).not.toHaveProperty("headers");
      expect(init).not.toHaveProperty("body");
    },
  );
  it("treats a missing legacy endpoint as normal sign-in, without manufacturing initialization", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(serverInitializationRequired(origin, request)).resolves.toBe(false);
  });
  it.each([{}, null, [], { required: "false" }])(
    "rejects invalid state without inferring a fresh server (%j)",
    async (value) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value)));
      await expect(serverInitializationRequired(origin, request)).rejects.toThrow(
        "Could not pair this server. Try again.",
      );
    },
  );
  it.each([401, 403, 429, 500])(
    "does not treat a failed state query as initialization permission (%s)",
    async (status) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("private detail", { status }));
      await expect(serverInitializationRequired(origin, request)).rejects.toThrow(
        "Could not pair this server. Try again.",
      );
    },
  );
  it("rejects oversized state responses", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"required":true}', {
        headers: { "content-length": String(MAX_API_PROBE_RESPONSE_BYTES + 1) },
      }),
    );
    await expect(serverInitializationRequired(origin, request)).rejects.toThrow(
      "Could not pair this server. Try again.",
    );
  });
  it.each([
    `${origin}/path`,
    `https://user:pass@server.example.test`,
    "http://public.example.test",
  ])("does not send a request to a noncanonical origin (%s)", async (url) => {
    const request = vi.fn<typeof fetch>();
    await expect(serverInitializationRequired(url, request)).rejects.toThrow(
      "Could not pair this server. Try again.",
    );
    expect(request).not.toHaveBeenCalled();
  });
  it("bounds a hanging state query and aborts its network request", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    const result = serverInitializationRequired(origin, request);
    const assertion = expect(result).rejects.toThrow("Could not pair this server. Try again.");
    await vi.advanceTimersByTimeAsync(API_PROBE_TIMEOUT_MS);
    await assertion;
    expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
});
