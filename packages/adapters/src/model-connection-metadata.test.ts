// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { ModelConnectInputSchema } from "@orkbot/contracts";
import { expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { buildModelConnectPlaintext, modelCredentialDto } from "./model-connect.js";
import {
  dedupeModelConnectionPresets,
  modelConnectionMetadata,
  modelConnectionRouting,
  modelCredentialRouting,
} from "./model-connection-metadata.js";
import { listPiCatalog } from "./pi-models.js";
import { parseModelSecret } from "./pi-oauth.js";
import { resolvedModelRunFields, resolveModelKey } from "./run-model.js";

const provider = "cloudflare-ai-gateway";

it("exposes the same neutral connection requirements through the actual catalog", () => {
  const entry = listPiCatalog().find((entry) => entry.provider === provider)!;
  expect(entry.connection).toEqual(modelConnectionMetadata(provider));
  expect(entry.connection?.routingFields).toEqual([
    { key: "account", label: "Account ID", required: true },
    { key: "gateway", label: "Gateway ID", required: true },
  ]);
  expect(modelConnectionMetadata("constructor")).toBeUndefined();
  expect(modelConnectionMetadata("synthetic-unknown")).toBeUndefined();
});

it("dedupes only equivalent preset endpoints, preserving query and path distinctions", () => {
  const presets = dedupeModelConnectionPresets([
    { label: "First", baseUrl: "HTTPS://MODELS.EXAMPLE.TEST:443/v1/" },
    { label: "Same endpoint", baseUrl: "https://models.example.test/v1" },
    { label: "Other path", baseUrl: "https://models.example.test/v1/other" },
    { label: "First query", baseUrl: "https://models.example.test/v1?route=a" },
    { label: "Other query", baseUrl: "https://models.example.test/v1?route=b" },
  ]);
  expect(presets.map((preset) => preset.label)).toEqual([
    "First",
    "Other path",
    "First query",
    "Other query",
  ]);
  expect(presets[0]?.baseUrl).toBe("https://models.example.test/v1");
});

it("projects old and partial records into generic fields without exposing unrelated values", () => {
  expect(
    modelCredentialRouting(provider, { accountId: "old-account", gatewayId: "old-gateway" }),
  ).toEqual({ account: "old-account", gateway: "old-gateway" });
  expect(modelCredentialRouting(provider, { accountId: "old-account" })).toEqual({
    account: "old-account",
  });
  expect(
    modelCredentialRouting(provider, {
      routing: { account: "canonical" },
      accountId: "old-account",
      gatewayId: "old-gateway",
    }),
  ).toEqual({ account: "canonical" });
  expect(
    modelCredentialRouting("cloudflare-workers-ai", {
      accountId: "old-account",
      gatewayId: "unrelated",
    }),
  ).toEqual({ account: "old-account" });
  const dto = modelCredentialDto(
    { id: "credential-1", provider, label: "Connection" },
    JSON.stringify({
      kind: "api_key",
      key: "fake-key",
      accountId: "old-account",
      gatewayId: "old-gateway",
    }),
  );
  expect(dto).toMatchObject({
    routing: { account: "old-account", gateway: "old-gateway" },
    accountId: "old-account",
    gatewayId: "old-gateway",
  });
  const projected = (routing: Record<string, string>) =>
    modelCredentialDto(
      { id: "credential-1", provider, label: "Connection" },
      JSON.stringify({
        kind: "api_key",
        key: "fake-key",
        routing,
        accountId: "old-account",
        gatewayId: "old-gateway",
      }),
    );
  expect(projected({ account: "canonical-account", gateway: "canonical-gateway" })).toMatchObject({
    routing: { account: "canonical-account", gateway: "canonical-gateway" },
    accountId: "canonical-account",
    gatewayId: "canonical-gateway",
  });
  expect(projected({ account: "canonical-account" })).toMatchObject({
    routing: { account: "canonical-account" },
    accountId: "canonical-account",
  });
  expect(projected({ account: "canonical-account" })).not.toHaveProperty("gatewayId");
});

it("requires new routes, inherits only omitted update maps and dual-writes legacy fields", () => {
  expect(() => modelConnectionRouting({ provider })).toThrow();
  const old = { accountId: "old-account", gatewayId: "old-gateway" };
  expect(modelConnectionRouting({ provider }, old)).toEqual({
    ...old,
    routing: { account: "old-account", gateway: "old-gateway" },
  });
  for (const routing of [{}, { account: "new-account" }] as Record<string, string>[])
    expect(() => modelConnectionRouting({ provider, routing }, old)).toThrow();
  expect(() =>
    modelConnectionRouting({ provider }, { ...old, routing: { account: "partial" } }),
  ).toThrow();
  const plaintext = buildModelConnectPlaintext({
    provider,
    apiKey: "fake-api-key",
    routing: { account: "new-account", gateway: "new-gateway" },
  });
  expect(parseModelSecret(plaintext)).toEqual({
    kind: "api_key",
    key: "fake-api-key",
    routing: { account: "new-account", gateway: "new-gateway" },
    accountId: "new-account",
    gatewayId: "new-gateway",
  });
  // The previous running release reads these fields and ignores the additive routing map.
  expect(JSON.parse(plaintext)).toMatchObject({
    accountId: "new-account",
    gatewayId: "new-gateway",
  });
  const update = ModelConnectInputSchema.parse({
    provider,
    routing: { account: "changed", gateway: "changed" },
  });
  expect(parseModelSecret(buildModelConnectPlaintext(update, plaintext))).toMatchObject({
    kind: "api_key",
    key: "fake-api-key",
    routing: { account: "changed", gateway: "changed" },
    accountId: "changed",
    gatewayId: "changed",
  });
  expect(() => buildModelConnectPlaintext(update)).toThrow("API key");
});

it("uses canonical stored routing in the actual runtime bridge while preserving key registration", async () => {
  const plaintext = JSON.stringify({
    kind: "api_key",
    key: "fake-api-key",
    accountId: "old-account",
    gatewayId: "old-gateway",
    routing: { account: "canonical-account", gateway: "canonical-gateway" },
  });
  const load = vi.fn(async () => plaintext);
  const register = vi.fn();
  const deps = {
    billingEnabled: false,
    prisma: {
      secret: {
        findFirst: vi.fn(async () => ({ id: "secret-1", ciphertext: "fixture-ciphertext" })),
      },
    },
    secretStore: { load },
  } as unknown as ExecutorDeps;
  const result = await resolveModelKey(
    deps,
    "user-1",
    "space-1",
    { id: "credential-1", secretId: "secret-1", provider },
    provider,
    "fixture-model",
    register,
  );
  expect(result).toMatchObject({
    apiKey: "fake-api-key",
    accountId: "canonical-account",
    gatewayId: "canonical-gateway",
    routing: { account: "canonical-account", gateway: "canonical-gateway" },
    ownCredential: true,
  });
  expect(load).toHaveBeenCalledWith("fixture-ciphertext", "secret-1");
  expect(register).toHaveBeenCalledWith(["fake-api-key"]);
  expect(resolvedModelRunFields(result)).toMatchObject({
    routing: { account: "canonical-account", gateway: "canonical-gateway" },
    accountId: "canonical-account",
    gatewayId: "canonical-gateway",
  });
});

it("rejects conflicting aliases and undeclared or unsafe values independently of UI metadata", () => {
  expect(() =>
    modelConnectionRouting({
      provider,
      routing: { account: "new", gateway: "route" },
      accountId: "old",
    }),
  ).toThrow("Invalid model connection");
  expect(() =>
    modelConnectionRouting({ provider, routing: { account: "valid", gateway: "../route" } }),
  ).toThrow();
  expect(() =>
    modelConnectionRouting({
      provider,
      routing: { account: "valid", gateway: "route", extra: "ignored" },
    }),
  ).toThrow();
  expect(() =>
    modelConnectionRouting({ provider: "synthetic-unknown", routing: { segment: "ignored" } }),
  ).toThrow();
  expect(modelConnectionRouting({ provider: "constructor" })).toBeUndefined();
});

it.each([
  null,
  [],
  { account: "../account" },
  { account: 42 },
  Object.fromEntries([["__proto__", "value"]]),
  Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`field${index}`, "value"])),
])(
  "refuses a corrupt persisted routing map instead of falling back to its legacy aliases: %j",
  (routing) => {
    expect(() =>
      parseModelSecret(
        JSON.stringify({ kind: "api_key", key: "fake-key", accountId: "old-account", routing }),
      ),
    ).toThrow("Stored model credential is corrupt. Connect the provider again.");
  },
);

it("applies known preset key policy to the effective URL and retains unknown keyless endpoint behavior", () => {
  const connect = (baseUrl: string, apiKey?: string, previous?: string) =>
    buildModelConnectPlaintext(
      {
        provider: "openai-compatible",
        modelId: "fixture-model",
        baseUrl,
        ...(apiKey !== undefined ? { apiKey } : {}),
      },
      previous,
    );
  for (const baseUrl of [
    "https://OLLAMA.COM:443",
    "https://ollama.com/v1/",
    "https://ollama.com/v1?ignored=1",
  ])
    expect(() => connect(baseUrl)).toThrow("This endpoint requires an API key.");
  const saved = connect("https://ollama.com", "fake-key");
  expect(parseModelSecret(connect("https://ollama.com/v1", undefined, saved))).toMatchObject({
    apiKey: "fake-key",
  });
  expect(parseModelSecret(connect("https://models.example.test"))).toMatchObject({
    baseUrl: "https://models.example.test/v1",
  });
});
