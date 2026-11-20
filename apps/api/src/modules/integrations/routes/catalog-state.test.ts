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
function setup(
  providers: Array<{
    id: string;
    catalog: ReturnType<typeof vi.fn>;
    listActiveConnectionRefs?: ReturnType<typeof vi.fn>;
    listReconnectRefs?: ReturnType<typeof vi.fn>;
  }>,
  prisma?: unknown,
) {
  const configuredProviders = vi.fn(async () => providers.map(({ id }) => ({ id })));
  const secrets = { put: vi.fn() };
  const handler = new RPCHandler(
    createRouter({
      secrets,
      prisma: prisma ?? {},
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

describe("catalog authorization reconciliation", () => {
  function fixture(failLookup = false) {
    const rows = [
      {
        id: "old",
        provider: "mail",
        providerRef: "ca-old",
        status: "pending",
        displayName: "Mail",
        createdAt: new Date(Date.now() - 1000),
      },
      {
        id: "new",
        provider: "mail",
        providerRef: "ca-new",
        status: "pending",
        displayName: "Mail",
        createdAt: new Date(),
      },
      {
        id: "dead",
        provider: "calendar",
        providerRef: "ca-dead",
        status: "connected",
        displayName: "Calendar",
        createdAt: new Date(),
      },
    ];
    const connection = {
      findMany: vi.fn(async () => rows.map((row) => ({ ...row }))),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: {
            id?: string | { in: string[] };
            status: string | { in: string[] };
            providerRef?: string | { in: string[] };
          };
          data: { status: string };
        }) => {
          let count = 0;
          for (const row of rows) {
            if (
              where.id &&
              (typeof where.id === "string" ? row.id !== where.id : !where.id.in.includes(row.id))
            )
              continue;
            if (
              typeof where.status === "string"
                ? row.status !== where.status
                : !where.status.in.includes(row.status)
            )
              continue;
            if (
              where.providerRef &&
              (typeof where.providerRef === "string"
                ? row.providerRef !== where.providerRef
                : !where.providerRef.in.includes(row.providerRef))
            )
              continue;
            row.status = data.status;
            count++;
          }
          return { count };
        },
      ),
    };
    const prisma = {
      connection,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ connection }),
    };
    const listActiveConnectionRefs = vi.fn(async () => {
      if (failLookup) throw new Error("provider unavailable");
      return ["ca-new"];
    });
    const item = {
      connectorId: "fixture",
      slug: "mail",
      name: "Mail",
      connected: true,
      noAuth: false,
      logo: null,
    };
    const client = setup(
      [
        {
          id: "fixture",
          catalog: vi.fn(async () => [item]),
          listActiveConnectionRefs,
          listReconnectRefs: vi.fn(async () => ["ca-dead"]),
        },
      ],
      prisma,
    );
    return { ...client, rows, connection, listActiveConnectionRefs, item };
  }

  it("connects the authorized retry and retires the abandoned first attempt", async () => {
    const h = fixture();
    expect((await h.call("connections/catalogSnapshot")).status).toBe(200);
    expect(h.rows.map((row) => row.status)).toEqual(["revoked", "connected", "error"]);
    expect(h.listActiveConnectionRefs).toHaveBeenCalledOnce();
  });

  it("keeps pending attempts on provider failure while still reconciling dead accounts", async () => {
    const h = fixture(true);
    const result = await (await h.call("connections/catalogSnapshot")).json();
    expect(result.json.items).toEqual([h.item]);
    expect(result.json.providers).toEqual([{ id: "fixture", status: "ready" }]);
    expect(h.rows.map((row) => row.status)).toEqual(["pending", "pending", "error"]);
  });

  it("does not revoke a recent login when the live catalog is still empty", async () => {
    const h = fixture();
    h.listActiveConnectionRefs.mockResolvedValue([]);
    expect((await h.call("connections/catalogSnapshot")).status).toBe(200);
    expect(h.rows.slice(0, 2).map((row) => row.status)).toEqual(["pending", "pending"]);
  });
});
