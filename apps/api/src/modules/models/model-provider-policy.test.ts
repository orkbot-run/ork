// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { parseModelSecret, serializeModelSecret } from "@orkbot/adapters";
import type { Actor } from "@orkbot/contracts";
import { createRouterClient } from "@orpc/server";
import { afterEach, expect, it, vi } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";
import { createRouterContext } from "#modules/platform/routes/context";
import { createModelConnector, prepareModelCredential } from "./model-credentials.js";
import { canCopyModelPin } from "./model-pins.js";

const actor: Actor = {
  userId: "policy-member",
  spaceId: "policy-space",
  email: "member@example.test",
  isDeploymentOwner: false,
};
vi.mock("@orkbot/adapters", async (original) => ({
  ...(await original<typeof import("@orkbot/adapters")>()),
  resolveMemberMainModel: vi.fn(async () => null),
}));
afterEach(() => vi.unstubAllEnvs());

function setup() {
  const deps = {
    prisma: {
      userModelCredential: { findFirst: vi.fn(), findMany: vi.fn() },
      secret: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
    },
    secrets: { load: vi.fn(), put: vi.fn() },
    env: {},
    modelConnectionFetch: vi.fn(),
    modelConnectionCheck: vi.fn(),
    oauthLogins: { begin: vi.fn() },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } as never });
  return { deps, client, connector: createModelConnector(deps, {} as never) };
}

it("drops a copied bot's blocked pin without looking up its credential", async () => {
  vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "anthropic");
  const { deps } = setup();
  await expect(
    canCopyModelPin(deps, actor, {
      modelProvider: "openrouter",
      modelId: "fixture/model",
      modelConnectionId: "blocked",
    }),
  ).resolves.toBe(false);
  expect(deps.prisma.userModelCredential.findFirst).not.toHaveBeenCalled();
  expect(deps.secrets.load).not.toHaveBeenCalled();
});

it("rejects a blocked connection before reading a saved key or probing the provider", async () => {
  vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "ollama-cloud");
  const { deps, connector } = setup();
  await expect(
    connector.verifyModelConnection(actor, { provider: "openai", apiKey: "key" }, undefined),
  ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("blocked") });
  expect(deps.prisma.userModelCredential.findFirst).not.toHaveBeenCalled();
  expect(deps.secrets.load).not.toHaveBeenCalled();
  expect(deps.modelConnectionFetch).not.toHaveBeenCalled();
});

it("stores the OpenRouter ZDR choice separately from standard key verification", async () => {
  vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "openrouter");
  const { deps, connector } = setup();
  vi.mocked(deps.modelConnectionFetch!).mockResolvedValue(new Response("{}"));
  const { plaintext } = await connector.verifyModelConnection(
    actor,
    {
      provider: "openrouter",
      apiKey: "fixture-key",
      modelId: "fixture/model",
      zeroDataRetention: true,
    },
    undefined,
  );
  expect(parseModelSecret(plaintext)).toMatchObject({ zeroDataRetention: true });
  const probe = vi.mocked(deps.modelConnectionCheck!);
  expect(probe).toHaveBeenCalledOnce();
  expect(probe.mock.calls[0]?.[0]).not.toHaveProperty("zeroDataRetention");
});

it("rejects ZDR for unsupported credentials before probing the provider", async () => {
  vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "openai");
  const { deps, connector } = setup();
  await expect(
    connector.verifyModelConnection(
      actor,
      { provider: "openai", apiKey: "fixture-key", zeroDataRetention: true },
      undefined,
    ),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(deps.modelConnectionFetch).not.toHaveBeenCalled();
  expect(deps.modelConnectionCheck).not.toHaveBeenCalled();
});

it("rejects custom compatible endpoints before reading credentials under a preset-only policy", async () => {
  vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "ollama-cloud");
  const { deps, connector } = setup();
  await expect(
    connector.verifyModelConnection(
      actor,
      {
        provider: "openai-compatible",
        baseUrl: "https://example.test/v1",
        apiKey: "key",
        modelId: "test",
      },
      undefined,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(deps.prisma.userModelCredential.findFirst).not.toHaveBeenCalled();
  expect(deps.modelConnectionFetch).not.toHaveBeenCalled();
});

it("rejects imported or OAuth credentials before secret persistence", async () => {
  vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "ollama-cloud");
  const { deps } = setup();
  await expect(
    prepareModelCredential(
      deps,
      actor,
      {
        provider: "openai",
        credentialId: null,
        plaintext: "key",
      },
      {} as never,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(deps.secrets.put).not.toHaveBeenCalled();
});

it("gates probes, default selection and OAuth start before dependent work", async () => {
  vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "ollama-cloud");
  const { deps, client } = setup();
  await expect(
    client.models.probeCatalog({ provider: "openai", apiKey: "fixture-key" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    client.models.probeOpenAiCompatible({ baseUrl: "https://example.test/v1" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    client.models.setDefault({ provider: "openai", modelId: "test" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(client.models.beginOAuth({ provider: "openai-codex" })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(deps.modelConnectionFetch).not.toHaveBeenCalled();
  expect(deps.oauthLogins.begin).not.toHaveBeenCalled();
  expect(deps.secrets.load).not.toHaveBeenCalled();
});

it("checks the saved compatible endpoint before a verification request", async () => {
  vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "ollama-cloud");
  const { deps, connector } = setup();
  vi.mocked(deps.prisma.userModelCredential.findFirst).mockResolvedValue({
    id: "saved",
    secretId: "secret",
  } as never);
  vi.mocked(deps.prisma.secret.findFirst).mockResolvedValue({ ciphertext: "encrypted" } as never);
  vi.mocked(deps.secrets.load).mockResolvedValue(
    serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "https://example.test/v1",
      apiKey: "key",
      enabledModelIds: ["test"],
    } as never),
  );
  await expect(
    connector.verifyModelConnection(
      actor,
      {
        provider: "openai-compatible",
        credentialId: "saved",
        modelId: "test",
        apiKey: "replacement",
      },
      undefined,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(deps.modelConnectionFetch).not.toHaveBeenCalled();
  expect(deps.secrets.put).not.toHaveBeenCalled();
});

it("returns minimal metadata for a saved blocked provider without loading its secret", async () => {
  vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "ollama-cloud");
  const { deps, client } = setup();
  vi.mocked(deps.prisma.userModelCredential.findMany).mockResolvedValue([
    {
      id: "saved",
      provider: "openai",
      label: "Old account",
      secretId: "secret",
      userPreferences: [],
    },
  ] as never);
  await expect(client.models.credentials()).resolves.toEqual([
    {
      id: "saved",
      provider: "openai",
      label: "Old account",
      hasKey: true,
      isDefault: false,
      blockedByPolicy: true,
    },
  ]);
  expect(deps.prisma.secret.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ id: { in: [] } }),
    }),
  );
  expect(deps.secrets.load).not.toHaveBeenCalled();
});

it("refuses imported credential preparation before saving secret material", async () => {
  vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "ollama-cloud");
  const { deps } = setup();
  await expect(
    prepareModelCredential(
      deps,
      actor,
      {
        provider: "openai",
        credentialId: null,
        plaintext: "fixture-key",
      },
      {} as never,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(deps.secrets.put).not.toHaveBeenCalled();
});

it("rejects blocked role and backup choices before building the catalog or resolving credentials", async () => {
  vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "ollama-cloud");
  const { deps } = setup();
  const context = createRouterContext(deps);
  await expect(
    context.validateRoleChoices(actor, "main", [{ provider: "openai", modelId: "test" }]),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(deps.prisma.userModelCredential.findMany).not.toHaveBeenCalled();
  expect(deps.secrets.load).not.toHaveBeenCalled();
});
