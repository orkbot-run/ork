// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AgentRunRequest } from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDeploymentModel } from "./deployment-model.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { MODEL_PROVIDER_BLOCKED_MESSAGE } from "./model-provider-policy.js";
import { deploymentModelRole, resolveMemberMainModel } from "./model-roles.js";
import {
  connectedModelSeesImages,
  findConnectedModelCredential,
  modelCredentialAuthKindsForSpace,
  pinnedModelCredentialError,
  prepareStoredModelAuth,
  validateConnectedModelChoice,
} from "./model-selection.js";
import { codexLiveCatalogsForSpace } from "./pi-codex-catalog.js";
import { ProviderCatalogCache } from "./pi-live-catalog.js";
import { serializeModelSecret } from "./pi-oauth.js";
import { resolveRuntimeModel } from "./pi-runtime-models.js";
import { selectAutoReviewCandidates } from "./run-auto-review.js";
import { resolveModelKey } from "./run-model.js";
import { resolveWorkspaceModel } from "./workspace-model-policy.js";

const scope = { userId: "member", spaceId: "space" };
afterEach(() => vi.unstubAllEnvs());

describe("operator model provider policy at runtime", () => {
  it("rejects a blocked pinned model with a stable reason before looking up credentials", async () => {
    vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "openrouter");
    const prisma = {} as PrismaClient;
    const load = vi.fn();
    expect(
      await findConnectedModelCredential(prisma, { load }, scope, "anthropic", "model"),
    ).toBeNull();
    expect(await validateConnectedModelChoice(prisma, { load }, scope, "anthropic", "model")).toBe(
      MODEL_PROVIDER_BLOCKED_MESSAGE,
    );
    expect(
      pinnedModelCredentialError(
        { modelProvider: "anthropic", modelId: "model", thinkingLevel: null },
        null,
      ),
    ).toBe(MODEL_PROVIDER_BLOCKED_MESSAGE);
    await expect(
      resolveModelKey(
        { prisma, secretStore: { load } } as unknown as ExecutorDeps,
        scope.userId,
        scope.spaceId,
        { id: "connection", secretId: "secret", provider: "anthropic" },
        "anthropic",
        "model",
      ),
    ).rejects.toThrow(MODEL_PROVIDER_BLOCKED_MESSAGE);
    expect(load).not.toHaveBeenCalled();
  });

  it("does not decrypt blocked catalog slots or expose image support", async () => {
    vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "openrouter");
    const credential = { id: "connection", secretId: "secret", provider: "anthropic" };
    const prisma = {
      userModelCredential: { findMany: vi.fn().mockResolvedValue([credential]) },
      userModelPreference: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const load = vi.fn();
    expect((await modelCredentialAuthKindsForSpace(prisma, { load }, scope)).byProvider).toEqual(
      {},
    );
    expect(
      await connectedModelSeesImages(
        { prisma, secretStore: { load } },
        scope.userId,
        "anthropic",
        "claude-sonnet-5",
        null,
        true,
      ),
    ).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("filters a blocked member main model before credential resolution", async () => {
    vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "openrouter");
    const prisma = {
      userModelRoleChoice: {
        findMany: vi.fn().mockResolvedValue([
          {
            role: "main",
            position: 0,
            provider: "anthropic",
            modelId: "model",
            credentialId: "connection",
          },
        ]),
      },
      spaceModelRoleChoice: { findMany: vi.fn().mockResolvedValue([]) },
      spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const load = vi.fn();
    expect(await resolveMemberMainModel({ prisma, secretStore: { load } }, scope)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("disables a blocked environment default and removes blocked approval candidates", () => {
    vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "openrouter");
    expect(
      resolveDeploymentModel({
        PI_DEFAULT_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "private-key",
      }),
    ).toMatchObject({ configured: false, key: undefined, hostCredentials: false });
    const candidates = selectAutoReviewCandidates(
      {
        primarySource: "member",
        primary: { provider: "anthropic", modelId: "model" },
        backups: [{ provider: "openrouter", modelId: "backup" }],
      },
      false,
      { AUTO_REVIEW_PROVIDER: "scripted" },
    );
    expect(candidates.map(({ provider }) => provider)).toEqual(["openrouter"]);
  });

  it("blocks a saved custom endpoint after decryption when only Ollama Cloud is allowed", async () => {
    vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "ollama-cloud");
    const plaintext = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "https://custom.example/v1",
      apiKey: "private-key",
      apiProtocol: "chat-completions",
      visionModelIds: ["model"],
    });
    const prisma = {
      secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret", ciphertext: "encrypted" }) },
    } as unknown as PrismaClient;
    const load = vi.fn().mockResolvedValue(plaintext);
    expect(
      await prepareStoredModelAuth(
        prisma,
        { load },
        scope.userId,
        "secret",
        "openai-compatible",
        "model",
      ),
    ).toMatchObject({ auth: { status: "rejected", message: MODEL_PROVIDER_BLOCKED_MESSAGE } });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("enforces provider and compatible endpoint gates at the Pi boundary", () => {
    vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "ollama-cloud");
    expect(() =>
      resolveRuntimeModel({ provider: "anthropic", id: "model", apiKey: "private-key" }),
    ).toThrow(MODEL_PROVIDER_BLOCKED_MESSAGE);
    expect(() =>
      resolveRuntimeModel({
        provider: "openai-compatible",
        id: "model",
        baseUrl: "https://custom.example/v1",
      }),
    ).toThrow(MODEL_PROVIDER_BLOCKED_MESSAGE);
    expect(
      resolveRuntimeModel({
        provider: "openai-compatible",
        id: "model",
        baseUrl: "https://ollama.com/v1",
        apiKey: "private-key",
        apiProtocol: "chat-completions",
      } as AgentRunRequest["model"]).model,
    ).toBeDefined();
  });

  it("does not load a blocked workspace connection", async () => {
    vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "openrouter");
    const load = vi.fn();
    const prisma = {
      workspaceModelPolicy: {
        findFirst: vi.fn().mockResolvedValue({
          provider: "anthropic",
          modelId: "model",
          secretRef: "encrypted",
          secretId: "secret",
        }),
      },
    } as unknown as PrismaClient;
    await expect(
      resolveWorkspaceModel(
        { prisma, secretStore: { load } } as unknown as Parameters<typeof resolveWorkspaceModel>[0],
        scope.spaceId,
      ),
    ).rejects.toThrow(MODEL_PROVIDER_BLOCKED_MESSAGE);
    expect(load).not.toHaveBeenCalled();
  });

  it("skips blocked provider and Codex catalog reads before retrieving secrets", async () => {
    vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "anthropic");
    const apiKey = vi.fn();
    const probe = vi.fn();
    const cache = new ProviderCatalogCache({ enabled: true, probe });
    expect(
      await cache.read({ provider: "openrouter", secretId: "secret", version: "version", apiKey }),
    ).toBeUndefined();
    expect(apiKey).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    const live = await codexLiveCatalogsForSpace(
      {} as PrismaClient,
      { load: vi.fn() },
      scope,
      {} as Parameters<typeof codexLiveCatalogsForSpace>[3],
      {} as Parameters<typeof codexLiveCatalogsForSpace>[4],
    );
    expect(live.size).toBe(0);
  });
  it("continues from a blocked saved deployment default to an allowed environment default", () => {
    vi.stubEnv("ORKBOT_MODEL_PROVIDER_ALLOWLIST", "openrouter");
    expect(
      deploymentModelRole("main", {
        settings: { defaultModelProvider: "anthropic", defaultModelId: "blocked-model" },
        deployment: { provider: "openrouter", model: "allowed-model" },
      }).primary,
    ).toEqual({ provider: "openrouter", modelId: "allowed-model" });
  });
});
