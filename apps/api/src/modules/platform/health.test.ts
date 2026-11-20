// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved; neutral integration changes follow LICENSE.md.

import { InfisicalSecretStore } from "@orkbot/adapters";
import { describe, expect, it, vi } from "vitest";
import { infisicalFake } from "../../../../../packages/adapters/src/secret-store-fake.js";
import { DATABASE_CHECK_TIMEOUT_MS, healthRoutes } from "./health.js";

const app = healthRoutes(() => ({ runtime: "pi", sandbox: "docker", revision: "abc123" }));

describe("health routes", () => {
  it("reports degraded readiness during a store outage and recovers on later reads", async () => {
    const fake = infisicalFake();
    const writer = new InfisicalSecretStore(fake.options);
    const record = await writer.put("fake", {
      operationId: "test",
      traceId: "test",
      userId: "test",
      spaceId: "test",
      signal: new AbortController().signal,
    });
    await writer.close();
    fake.offline = true;
    const store = new InfisicalSecretStore(fake.options);
    await store.start();
    const health = healthRoutes(() => ({ degraded: store.describe().capabilities.degraded }));
    try {
      const response = await health.request("/ready");
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ ok: false, degraded: true });
      expect((await health.request("/health")).status).toBe(200);
      fake.offline = false;
      await store.load(record.ref, record.id);
      expect((await health.request("/ready")).status).toBe(200);
    } finally {
      await store.close();
    }
  });
  it("reports not ready while the database is unreachable", async () => {
    let up = false;
    const health = healthRoutes(
      () => ({}),
      async () => {
        if (!up) throw new Error("connection refused");
      },
    );
    const response = await health.request("/ready");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      degraded: false,
      database: "unreachable",
    });
    expect((await health.request("/health")).status).toBe(200);
    up = true;
    expect((await health.request("/ready")).status).toBe(200);
  });

  it("answers 503 at the deadline while the database hangs, with one probe at a time", async () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn(() => new Promise<never>(() => {}));
      const health = healthRoutes(() => ({}), check);
      const first = health.request("/ready");
      const second = health.request("/ready");
      expect((await health.request("/health")).status).toBe(200);
      await vi.advanceTimersByTimeAsync(DATABASE_CHECK_TIMEOUT_MS);
      expect((await first).status).toBe(503);
      expect((await second).status).toBe(503);
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps public liveness free of deployment details", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("serves details to direct requests on the API port", async () => {
    const response = await app.request("/internal/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      runtime: "pi",
      sandbox: "docker",
      revision: "abc123",
      telemetry: { failures: 0, lastFailureAt: null, degraded: false },
    });
  });

  it("hides details from requests that came through a reverse proxy", async () => {
    const proxied: Record<string, string>[] = [
      { "x-forwarded-for": "203.0.113.7" },
      { forwarded: "for=203.0.113.7;proto=https" },
    ];
    for (const headers of proxied) {
      const response = await app.request("/internal/health", { headers });
      expect(response.status).toBe(404);
    }
  });
});

it("loads private configured metadata only after the forwarded-header guard", async () => {
  const internal = vi.fn(async () => ({ integrations: [{ id: "fixture-adapter" }] }));
  const health = healthRoutes(
    () => ({}),
    async () => undefined,
    internal,
  );
  await expect((await health.request("/health")).json()).resolves.toEqual({ ok: true });
  await expect((await health.request("/ready")).json()).resolves.toEqual({
    ok: true,
    degraded: false,
  });
  const forwardedHeaders: Record<string, string>[] = [
    { "x-forwarded-for": "203.0.113.7" },
    { forwarded: "for=203.0.113.7" },
  ];
  for (const headers of forwardedHeaders)
    expect((await health.request("/internal/health", { headers })).status).toBe(404);
  expect(internal).not.toHaveBeenCalled();
  await expect((await health.request("/internal/health")).json()).resolves.toMatchObject({
    integrations: [{ id: "fixture-adapter" }],
  });
  expect(internal).toHaveBeenCalledOnce();
});

it.each(["failed", "hung"])(
  "bounds %s private metadata and hides its raw failure",
  async (mode) => {
    vi.useFakeTimers();
    try {
      const internal = vi.fn(() =>
        mode === "hung"
          ? new Promise<Record<string, unknown>>(() => {})
          : Promise.reject(new Error("fake-private-database-secret")),
      );
      const health = healthRoutes(() => ({}), undefined, internal);
      const pending = health.request("/internal/health");
      await vi.advanceTimersByTimeAsync(DATABASE_CHECK_TIMEOUT_MS);
      const body = await (await pending).json();
      expect(body).toMatchObject({ ok: true, diagnostics: "unavailable" });
      expect(JSON.stringify(body)).not.toContain("fake-private-database-secret");
    } finally {
      vi.useRealTimers();
    }
  },
);

it("shares pending private diagnostics across concurrent polls and timeouts, then reads fresh state", async () => {
  vi.useFakeTimers();
  try {
    let complete!: (value: Record<string, unknown>) => void;
    const internal = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue({ integrations: [{ id: "fresh-adapter" }] });
    const health = healthRoutes(() => ({}), undefined, internal);
    const first = health.request("/internal/health");
    const second = health.request("/internal/health");
    await vi.advanceTimersByTimeAsync(DATABASE_CHECK_TIMEOUT_MS);
    for (const pending of [first, second])
      await expect((await pending).json()).resolves.toMatchObject({ diagnostics: "unavailable" });
    const afterTimeout = health.request("/internal/health");
    await vi.advanceTimersByTimeAsync(DATABASE_CHECK_TIMEOUT_MS);
    await expect((await afterTimeout).json()).resolves.toMatchObject({
      diagnostics: "unavailable",
    });
    expect(internal).toHaveBeenCalledTimes(1);
    complete({ integrations: [{ id: "previous-adapter" }] });
    await vi.advanceTimersByTimeAsync(0);
    await expect((await health.request("/internal/health")).json()).resolves.toMatchObject({
      integrations: [{ id: "fresh-adapter" }],
    });
    expect(internal).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("retries private diagnostics after a rejected read settles", async () => {
  const internal = vi
    .fn()
    .mockRejectedValueOnce(new Error("fake-private-database-secret"))
    .mockResolvedValue({ integrations: [{ id: "recovered-adapter" }] });
  const health = healthRoutes(() => ({}), undefined, internal);
  await expect((await health.request("/internal/health")).json()).resolves.toMatchObject({
    diagnostics: "unavailable",
  });
  await expect((await health.request("/internal/health")).json()).resolves.toMatchObject({
    integrations: [{ id: "recovered-adapter" }],
  });
  expect(internal).toHaveBeenCalledTimes(2);
});

it.each([
  ["127.0.0.1", 200],
  ["127.42.0.1", 200],
  ["::1", 200],
  ["10.2.3.4", 200],
  ["172.17.0.1", 200],
  ["192.168.1.2", 200],
  ["fd00::1", 200],
  ["::ffff:127.0.0.1", 200],
  ["::ffff:ac11:1", 200],
  ["203.0.113.7", 404],
  ["2606:4700::1111", 404],
  ["::ffff:203.0.113.7", 404],
  ["::ffff:cb00:7107", 404],
  ["fe80::1", 404],
  ["0.0.0.0", 404],
  ["::", 404],
  ["172.32.0.1", 404],
  ["192.0.2.1", 404],
  ["not-an-ip", 404],
  ["", 404],
  ["127.0.0.1:1234", 404],
  ["[::1]", 404],
  [undefined, 404],
] as const)(
  "checks the actual socket peer %s before loading private details",
  async (remoteAddress, status) => {
    const details = vi.fn(() => ({ revision: "fixture-revision" }));
    const internal = vi.fn(async () => ({ integrations: [] }));
    const health = healthRoutes(details, undefined, internal);
    const response = await health.request(
      "/internal/health",
      {},
      {
        incoming: { socket: { remoteAddress } },
      },
    );
    expect(response.status).toBe(status);
    expect(internal).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    expect(details).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  },
);

it.each([
  { incoming: {} },
  { incoming: null },
  { server: {} },
  { server: { incoming: { socket: { remoteAddress: "203.0.113.7" } } } },
])("fails closed for invalid or public server socket bindings", async (env) => {
  expect((await app.request("/internal/health", {}, env)).status).toBe(404);
});

it.each(["x-forwarded-for", "forwarded"])(
  "refuses even empty %s from a private socket",
  async (header) => {
    expect(
      (
        await app.request(
          "/internal/health",
          { headers: { [header]: "" } },
          {
            incoming: { socket: { remoteAddress: "127.0.0.1" } },
          },
        )
      ).status,
    ).toBe(404);
  },
);

it("accepts a private peer from wrapped Node server bindings", async () => {
  expect(
    (
      await app.request(
        "/internal/health",
        {},
        {
          server: { incoming: { socket: { remoteAddress: "::ffff:192.168.1.2" } } },
        },
      )
    ).status,
  ).toBe(200);
});
