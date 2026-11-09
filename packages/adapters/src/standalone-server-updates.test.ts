// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it, vi } from "vitest";
import { createStandaloneServerUpdateAdapter } from "./standalone-server-updates.js";

const discovery = vi.hoisted(() => vi.fn());
vi.mock("./easypanel-server-updates.js", () => ({
  createOfficialServerUpdateDiscovery: () => discovery,
}));
const revision = "a".repeat(40);
const idempotencyKey = "123e4567-e89b-42d3-a456-426614174000";
const token = `fixture_token_${"x".repeat(32)}`;

describe("standalone server update adapter", () => {
  it("rechecks the candidate and authority before submitting the exact revision once", async () => {
    discovery.mockResolvedValue({ revision, version: "v1.2.3" });
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    const guard = vi.fn(async () => undefined);
    const adapter = createStandaloneServerUpdateAdapter(
      { channel: "stable", currentRevision: "b".repeat(40), token },
      { fetch },
    );
    await adapter.submit(revision, guard, idempotencyKey);
    expect(discovery).toHaveBeenCalled();
    expect(guard).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://updater:7092/deploy");
    expect(init.headers).toEqual({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      revision,
      idempotencyKey,
      channel: "stable",
    });
  });

  it("does not submit a changed candidate or a revoked authority", async () => {
    const fetch = vi.fn();
    const adapter = createStandaloneServerUpdateAdapter(
      { channel: "stable", currentRevision: "b".repeat(40), token },
      { fetch },
    );
    discovery.mockResolvedValue(null);
    await expect(adapter.submit(revision, async () => undefined, idempotencyKey)).rejects.toThrow();
    discovery.mockResolvedValue({ revision, version: "v1.2.3" });
    await expect(
      adapter.submit(
        revision,
        async () => {
          throw new Error("revoked");
        },
        idempotencyKey,
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads the sidecar journal without accepting malformed state", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ operation: { revision, idempotencyKey, state: "succeeded" } }),
      )
      .mockResolvedValueOnce(
        Response.json({ operation: { revision: "bad", idempotencyKey, state: "succeeded" } }),
      );
    const adapter = createStandaloneServerUpdateAdapter(
      { channel: "stable", currentRevision: null, token },
      { fetch },
    );
    await expect(adapter.operation?.()).resolves.toEqual({
      revision,
      idempotencyKey,
      state: "succeeded",
    });
    await expect(adapter.operation?.()).resolves.toBeNull();
  });
});
