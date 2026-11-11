// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { SecretStore } from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { validateBotModelChange } from "./model-selection.js";
import { serializeModelSecret } from "./pi-oauth.js";
import { restoreComputerModels } from "./pi-runtime-computer-mode.js";
import { resolveConnectedRunModel, resolveRunModel } from "./run-model.js";
import { EncryptedSecretStore } from "./secrets.js";
import { resolveWorkspaceModel } from "./workspace-model-policy.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-a",
  userId: "owner",
  signal: new AbortController().signal,
};

describe("workspace model policy", () => {
  it("restores a paused computer turn only when both saved models match the workspace", async () => {
    const secretStore = new EncryptedSecretStore("test-only-encryption-key-not-used-outside-tests");
    const record = await secretStore.put("private-test-api-key", context);
    const prisma = {
      workspaceModelPolicy: {
        findFirst: vi.fn().mockResolvedValue({
          provider: "openrouter",
          modelId: "company-model",
          secretId: record.id,
          secretRef: record.ref,
        }),
      },
    };
    const deps = { prisma, secretStore } as unknown as ExecutorDeps;
    const resolveFallbackModel = (provider: string, id: string) =>
      resolveConnectedRunModel(deps, context, provider, id);
    const selection = { provider: "openrouter", id: "company-model", auth: "api-key" as const };
    const checkpoint = {
      version: 1 as const,
      mode: "main" as const,
      main: selection,
      computer: selection,
    };
    await expect(
      restoreComputerModels({ resolveFallbackModel }, checkpoint),
    ).resolves.toMatchObject({ main: { id: "company-model" }, computer: { id: "company-model" } });
    await expect(
      restoreComputerModels(
        { resolveFallbackModel },
        { ...checkpoint, computer: { ...selection, id: "other-model" } },
      ),
    ).rejects.toThrow("not allowed by the workspace owner");
  });
  it("honors protocol and image settings while enforcing the private endpoint gate", async () => {
    const secretStore = new EncryptedSecretStore("test-only-encryption-key-not-used-outside-tests");
    const record = await secretStore.put(
      serializeModelSecret({
        kind: "openai_compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "private-test-api-key",
        apiProtocol: "responses",
        visionModelIds: ["my-model"],
      }),
      context,
    );
    const prisma = {
      workspaceModelPolicy: {
        findFirst: vi.fn().mockResolvedValue({
          provider: "openai-compatible",
          modelId: "my-model",
          secretId: record.id,
          secretRef: record.ref,
        }),
      },
    } as unknown as PrismaClient;
    await expect(resolveWorkspaceModel({ prisma, secretStore }, "space-a")).rejects.toThrow(
      "workspace model connection is unavailable",
    );
    await expect(
      resolveWorkspaceModel({ prisma, secretStore, mcpAllowPrivateEndpoint: true }, "space-a"),
    ).resolves.toMatchObject({
      model: {
        provider: "openai-compatible",
        id: "my-model",
        apiProtocol: "responses",
        acceptsImages: true,
        apiKey: "private-test-api-key",
      },
    });
  });
  it("rejects attempts to set a different bot model while a workspace policy exists", async () => {
    const deps = {
      prisma: {
        workspaceModelPolicy: {
          findFirst: vi.fn().mockResolvedValue({ provider: "company", modelId: "company-model" }),
        },
      },
      secretStore: {},
      refreshExpiredCredential: vi.fn(),
      defaultModel: vi.fn(),
    } as unknown as Parameters<typeof validateBotModelChange>[0];
    await expect(
      validateBotModelChange(deps, {
        userId: "member",
        spaceId: "space",
        provider: "personal",
        model: "other",
      }),
    ).resolves.toEqual({ ok: false, error: "Models are managed by the workspace owner." });
    await expect(
      validateBotModelChange(deps, {
        userId: "member",
        spaceId: "space",
        provider: "company",
        model: "company-model",
      }),
    ).resolves.toMatchObject({ ok: true, provider: null, model: null });
  });
  it("also enforces the model for auxiliary and pinned model resolvers", async () => {
    const secretStore = new EncryptedSecretStore("test-only-encryption-key-not-used-outside-tests");
    const record = await secretStore.put("private-test-api-key", context);
    const prisma = {
      workspaceModelPolicy: {
        findFirst: vi.fn().mockResolvedValue({
          provider: "openrouter",
          modelId: "company-model",
          secretId: record.id,
          secretRef: record.ref,
        }),
      },
    };
    const deps = { prisma, secretStore } as unknown as ExecutorDeps;
    await expect(resolveRunModel(deps, context)).resolves.toMatchObject({
      provider: "openrouter",
      id: "company-model",
    });
    await expect(resolveConnectedRunModel(deps, context, "personal", "unapproved")).rejects.toThrow(
      "not allowed by the workspace owner",
    );
    await expect(
      resolveConnectedRunModel(deps, context, "openrouter", "company-model"),
    ).resolves.toMatchObject({ provider: "openrouter", id: "company-model" });
  });
  it("uses the organization credential and never queries a member credential", async () => {
    const secretStore = new EncryptedSecretStore("test-only-encryption-key-not-used-outside-tests");
    const record = await secretStore.put("private-test-api-key", context);
    const findFirst = vi.fn().mockResolvedValue({
      provider: "openrouter",
      modelId: "company-model",
      secretId: record.id,
      secretRef: record.ref,
    });
    const prisma = {
      workspaceModelPolicy: { findFirst },
      userModelCredential: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    const result = await resolveWorkspaceModel({ prisma, secretStore }, "space-a");
    expect(findFirst).toHaveBeenCalledWith({
      where: { organization: { spaces: { some: { id: "space-a" } } } },
    });
    expect(result?.model).toMatchObject({
      provider: "openrouter",
      id: "company-model",
      apiKey: "private-test-api-key",
    });
    expect(result?.redact).toContain("private-test-api-key");
    expect(prisma.userModelCredential.findFirst).not.toHaveBeenCalled();
  });

  it("fails closed and never exposes a store error when the shared key cannot be loaded", async () => {
    const prisma = {
      workspaceModelPolicy: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ provider: "x", modelId: "y", secretId: "1", secretRef: "2" }),
      },
    } as unknown as PrismaClient;
    const secretStore = {
      load: vi.fn().mockRejectedValue(new Error("private-test-api-key")),
    } as unknown as SecretStore;
    await expect(resolveWorkspaceModel({ prisma, secretStore }, "space-a")).rejects.toThrow(
      "The workspace model connection is unavailable",
    );
    await expect(resolveWorkspaceModel({ prisma, secretStore }, "space-a")).rejects.not.toThrow(
      "private-test-api-key",
    );
  });

  it("does not treat a database error as no policy", async () => {
    const prisma = {
      workspaceModelPolicy: { findFirst: vi.fn().mockRejectedValue(new Error("db offline")) },
    } as unknown as PrismaClient;
    await expect(
      resolveWorkspaceModel({ prisma, secretStore: {} as SecretStore }, "space-a"),
    ).rejects.toThrow("db offline");
  });

  it("returns no policy when the workspace did not configure a model", async () => {
    const prisma = {
      workspaceModelPolicy: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    expect(
      await resolveWorkspaceModel({ prisma, secretStore: {} as SecretStore }, "space-a"),
    ).toBeNull();
  });
});
