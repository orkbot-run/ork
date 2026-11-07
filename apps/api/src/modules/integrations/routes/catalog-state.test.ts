// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { Actor } from "@orkbot/contracts";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";

const actor = {
  userId: "user",
  spaceId: "space",
  email: "user@example.test",
  isDeploymentOwner: false,
} as Actor;
function setup(providers: Array<{ id: string; catalog: ReturnType<typeof vi.fn> }>) {
  const configuredProviders = vi.fn(async () => providers.map(({ id }) => ({ id })));
  const secrets = { put: vi.fn() };
  const handler = new RPCHandler(
    createRouter({
      prisma: {},
      secrets,
      connectors: {
        configuredProviders,
        managed: (id: string) => providers.find((provider) => provider.id === id),
      },
      env: { webOrigin: "https://example.test" },
    } as unknown as RouterDeps),
  );
  async function call(path: string, input = {}) {
    const result = await handler.handle(
      new Request(`https://example.test/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    if (!result.matched) throw new Error("missing route");
    return result.response;
  }
  return { call, configuredProviders, secrets };
}

describe("integration catalog outcomes", () => {
  it("distinguishes unconfigured and successfully empty deployments", async () => {
    const unconfigured = setup([]);
    expect(await (await unconfigured.call("connections/catalogSnapshot")).json()).toEqual({
      json: { items: [], providers: [] },
    });
    const catalog = vi.fn(async () => []);
    const configured = setup([{ id: "fixture", catalog }]);
    expect(await (await configured.call("connections/catalogSnapshot")).json()).toEqual({
      json: { items: [], providers: [{ id: "fixture", status: "ready" }] },
    });
    expect(catalog).toHaveBeenCalledOnce();
    expect(configured.configuredProviders).toHaveBeenCalledOnce();
  });
  it("retains successful apps and reports only configured unavailable providers", async () => {
    const item = {
      connectorId: "ready",
      slug: "fixture",
      name: "Fixture",
      logo: null,
      connected: false,
      noAuth: true,
    };
    const ready = vi.fn(async () => [item]);
    const failed = vi.fn(async () => {
      throw new Error("fake-private-provider-token");
    });
    const { call } = setup([
      { id: "ready", catalog: ready },
      { id: "failed", catalog: failed },
    ]);
    const snapshot = await (await call("connections/catalogSnapshot")).json();
    expect(snapshot).toEqual({
      json: {
        items: [item],
        providers: [
          { id: "ready", status: "ready" },
          { id: "failed", status: "unavailable" },
        ],
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("fake-private");
    expect(ready).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
    expect(await (await call("connections/catalog")).json()).toEqual({ json: [item] });
    expect(ready).toHaveBeenCalledTimes(2);
    expect(failed).toHaveBeenCalledTimes(2);
  });
  it.each(["removed", "fixture"])(
    "rejects unknown or overridden preset intent before effects: %s",
    async (presetId) => {
      const { call, secrets } = setup([]);
      const input =
        presetId === "removed"
          ? { presetId, name: "Fixture" }
          : {
              presetId,
              name: "Fixture",
              kind: "mcp",
              source: "https://override.example.test",
              config: {},
            };
      expect((await call("capabilities/install", input)).status).toBe(400);
      expect(secrets.put).not.toHaveBeenCalled();
    },
  );
});
