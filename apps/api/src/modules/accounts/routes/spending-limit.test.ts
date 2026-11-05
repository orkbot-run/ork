// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Actor } from "@orkbot/contracts";
import type * as DatabaseModule from "@orkbot/db";
import { readSpendingLimit, recordSecurityEvent, setSpendingLimit } from "@orkbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";

vi.mock("@orkbot/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseModule>()),
  readSpendingLimit: vi.fn(),
  setSpendingLimit: vi.fn(),
  recordSecurityEvent: vi.fn(async () => undefined),
}));

const actor = {
  spaceId: "space-one",
  userId: "user-one",
  email: "account@example.test",
  isDeploymentOwner: false,
} satisfies Actor;

const limit = { amount: 125.29, currency: "PLN", period: "weekly" } as const;

function setup() {
  const deps = {
    prisma: {},
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/orkbot-spending-limit-test",
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function call(procedure: "get" | "set", input: unknown, caller: Actor | null = actor) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/spendingLimit/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: caller } },
    );
    if (!response) throw new Error("Procedure did not match");
    return { status: response.status, body: (await response.json()) as { json: unknown } };
  }
  return { deps, call };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readSpendingLimit).mockResolvedValue({ limit: null, spent: 0 });
  vi.mocked(setSpendingLimit).mockImplementation(async (_db, _userId, next) => ({
    limit: next,
    spent: 25,
  }));
});

describe("account spending limit routes", () => {
  it("reads only the authenticated user's account across Spaces", async () => {
    const { deps, call } = setup();
    vi.mocked(readSpendingLimit).mockResolvedValue({ limit, spent: 25 });
    const first = await call("get", {});
    const second = await call("get", {}, { ...actor, spaceId: "space-two" });
    expect(first).toEqual({ status: 200, body: { json: { limit, spent: 25 } } });
    expect(second).toEqual(first);
    expect(readSpendingLimit).toHaveBeenCalledTimes(2);
    expect(readSpendingLimit).toHaveBeenNthCalledWith(1, deps.prisma, actor.userId);
    expect(readSpendingLimit).toHaveBeenNthCalledWith(2, deps.prisma, actor.userId);
  });

  it("saves PLN and records the account policy change", async () => {
    const { deps, call } = setup();
    expect(await call("set", { limit })).toEqual({
      status: 200,
      body: { json: { limit, spent: 25 } },
    });
    expect(setSpendingLimit).toHaveBeenCalledWith(deps.prisma, actor.userId, limit);
    expect(recordSecurityEvent).toHaveBeenCalledWith({
      type: "spending.limit.changed",
      userId: actor.userId,
      spaceId: actor.spaceId,
      metadata: {
        procedure: "spendingLimit.set",
        kind: "account_spending_limit",
        currency: "PLN",
        period: "weekly",
        amount: 125.29,
        enabled: true,
      },
    });
  });

  it("removes the limit and audits the disabled state", async () => {
    const { call } = setup();
    expect((await call("set", { limit: null })).status).toBe(200);
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          procedure: "spendingLimit.set",
          kind: "account_spending_limit",
          enabled: false,
        },
      }),
    );
  });

  it("rejects unauthenticated reads and writes", async () => {
    const { call } = setup();
    expect((await call("get", {}, null)).status).toBe(401);
    expect((await call("set", { limit }, null)).status).toBe(401);
    expect(readSpendingLimit).not.toHaveBeenCalled();
    expect(setSpendingLimit).not.toHaveBeenCalled();
    expect(recordSecurityEvent).not.toHaveBeenCalled();
  });

  it.each([
    { limit: { ...limit, amount: -1 } },
    { limit: { ...limit, amount: 1.001 } },
    { limit: { ...limit, currency: "JPY" } },
    { limit: { ...limit, period: "yearly" } },
    { limit, scope: "space" },
    { limit, userId: "user-two" },
    { limit, spaceId: "space-two" },
  ])("rejects invalid or externally scoped settings: %j", async (input) => {
    const { call } = setup();
    expect((await call("set", input)).status).toBe(400);
    expect(setSpendingLimit).not.toHaveBeenCalled();
    expect(recordSecurityEvent).not.toHaveBeenCalled();
  });

  it("does not audit a failed save", async () => {
    const { call } = setup();
    vi.mocked(setSpendingLimit).mockRejectedValue(new Error("Database unavailable"));
    expect((await call("set", { limit })).status).toBe(500);
    expect(recordSecurityEvent).not.toHaveBeenCalled();
  });
});
