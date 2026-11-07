// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { serializeModelSecret } from "@orkbot/adapters";
import type { Actor } from "@orkbot/contracts";
import { createRouterClient } from "@orpc/server";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";
import type * as PiModelsModule from "../../../../../packages/adapters/src/pi-models.js";
import type { PiCatalogEntry } from "../../../../../packages/adapters/src/pi-models.js";

// The saved per-account auth fixture remains available when upstream retires its entry.
vi.mock("../../../../../packages/adapters/src/pi-models.js", async (original) => {
  const actual = await original<typeof PiModelsModule>();
  const stored: PiCatalogEntry = {
    provider: "openai-codex",
    providerName: "Fixture subscription",
    id: "gpt-5.3-codex-spark",
    label: "Stored auth-restricted model",
    auth: "oauth",
    billing: "Fixture",
    subscription: true,
  };
  return {
    ...actual,
    listPiCatalog: () => [
      ...actual
        .listPiCatalog()
        .filter((entry) => entry.provider !== stored.provider || entry.id !== stored.id),
      stored,
    ],
  };
});

it("shares list and per-connection auth reads, then rereads rotated or removed credentials", async () => {
  const actor: Actor = {
    userId: "user-test",
    spaceId: "space-test",
    email: "user@example.test",
    isDeploymentOwner: false,
  };
  const credentials = [
    {
      id: "credential-a",
      provider: "openai-codex",
      secretId: "secret-a",
      createdAt: new Date(2),
      updatedAt: new Date(2),
    },
    {
      id: "credential-b",
      provider: "openai-codex",
      secretId: "secret-b",
      createdAt: new Date(1),
      updatedAt: new Date(1),
    },
  ];
  const records = [
    { id: "secret-a", ciphertext: "pro-v1" },
    { id: "secret-b", ciphertext: "plus-v1" },
  ];
  const signedIn = (accountId: string) =>
    serializeModelSecret({
      kind: "oauth",
      credential: {
        type: "oauth",
        accountId,
        access: `fake.${Buffer.from(JSON.stringify({ chatgpt_account_id: accountId })).toString("base64url")}.fake`,
        refresh: "fake-refresh",
        expires: Date.now() + 60_000,
      },
    });
  const load = vi.fn(async (ciphertext: string) =>
    signedIn(ciphertext.startsWith("pro") ? "account-pro" : "account-plus"),
  );
  const prisma = {
    userModelCredential: { findMany: vi.fn(async () => credentials.slice()) },
    userModelPreference: { findMany: vi.fn(async () => []) },
    secret: {
      findMany: vi.fn(async ({ where }) =>
        records.filter((row) => where.id.in.includes(row.id)).map((row) => ({ ...row })),
      ),
      findFirst: vi.fn(),
    },
    bot: { findMany: vi.fn(async () => []) },
    routine: { findMany: vi.fn(async () => []) },
    userModelRoleChoice: { findMany: vi.fn(async () => []) },
    spaceModelRoleChoice: { findMany: vi.fn(async () => []) },
    deploymentSettings: { findFirst: vi.fn(async () => null) },
  };
  const codexCatalog = {
    read: vi.fn(async (_userId: string, account: { accountId: string }) =>
      account.accountId === "account-pro"
        ? [
            {
              slug: "gpt-5.3-codex-spark",
              reasoningEfforts: [],
              supportsImages: false,
              supportsFastTier: false,
            },
          ]
        : [],
    ),
  };
  const deps = {
    prisma,
    secrets: { load },
    codexCatalog,
    env: { agentRuntime: "pi", defaultProvider: "fake", defaultModel: "fake" },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } as never });
  const first = await client.models.forRole({ role: "main" });
  expect(
    first.find((entry) => entry.provider === "openai-codex" && entry.id === "gpt-5.3-codex-spark"),
  ).toMatchObject({ credentialIds: ["credential-a"] });
  expect(load).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledWith("pro-v1", "secret-a");
  expect(load).toHaveBeenCalledWith("plus-v1", "secret-b");
  expect(prisma.secret.findMany).toHaveBeenCalledTimes(2);
  expect(prisma.secret.findFirst).not.toHaveBeenCalled();
  for (const [args] of prisma.secret.findMany.mock.calls)
    expect(args.where).toMatchObject({ userId: actor.userId, spaceId: null });

  // The same router handles another request after the serving account changes plan/token.
  records[0]!.ciphertext = "plus-v2";
  const second = await client.models.forRole({ role: "main" });
  expect(
    second.find((entry) => entry.provider === "openai-codex" && entry.id === "gpt-5.3-codex-spark"),
  ).toBeUndefined();
  expect(load).toHaveBeenCalledTimes(3);
  expect(load).toHaveBeenCalledWith("plus-v2", "secret-a");
  expect(prisma.secret.findMany).toHaveBeenCalledTimes(3);

  credentials.length = 0;
  const disconnected = await client.models.forRole({ role: "main" });
  expect(
    disconnected.find(
      (entry) => entry.provider === "openai-codex" && entry.id === "gpt-5.3-codex-spark",
    ),
  ).toBeUndefined();
  expect(load).toHaveBeenCalledTimes(3);
  expect(prisma.secret.findMany).toHaveBeenCalledTimes(3);
});
