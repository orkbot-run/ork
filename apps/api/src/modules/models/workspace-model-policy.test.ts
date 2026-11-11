// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { EncryptedSecretStore } from "@orkbot/adapters";
import type { Actor } from "@orkbot/contracts";
import { createRouterClient } from "@orpc/server";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";

it("lets only the owner save and remove a shared key and never returns it", async () => {
  const key = "fake-workspace-secret-key";
  type Policy = {
    organizationId: string;
    provider: string;
    modelId: string;
    secretId: string;
    secretRef: string;
  };
  let saved: Policy | null = null;
  const policy = {
    findUnique: vi.fn(async ({ select }: { select: Record<string, boolean> }) => {
      if (!saved) return null;
      return Object.fromEntries(
        Object.keys(select).map((field) => [field, saved![field as keyof Policy]]),
      );
    }),
    findFirst: vi.fn(async () => saved),
    upsert: vi.fn(async ({ create }: { create: Policy }) => {
      saved = create;
      return saved;
    }),
    deleteMany: vi.fn(async () => {
      saved = null;
      return { count: 1 };
    }),
  };
  const prisma = {
    space: {
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({
        organizationId: "org",
        organization: { members: [{ role: where.id === "owner-space" ? "owner" : "member" }] },
      })),
    },
    workspaceModelPolicy: policy,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ workspaceModelPolicy: policy }),
    ),
  };
  const secrets = new EncryptedSecretStore("a-test-encryption-key-not-used-outside-this-test");
  const deps = {
    prisma,
    secrets,
    env: { agentRuntime: "pi", defaultProvider: "openrouter", defaultModel: "model" },
    modelConnectionFetch: vi.fn(async () => new Response("{}", { status: 200 })),
  } as unknown as RouterDeps;
  const client = (spaceId: string) =>
    createRouterClient(createRouter(deps), {
      context: {
        actor: {
          userId: spaceId,
          spaceId,
          email: `${spaceId}@example.test`,
          isDeploymentOwner: false,
        } satisfies Actor,
      } as never,
    });
  const owner = client("owner-space");
  const member = client("member-space");
  const input = { provider: "openrouter", modelId: "test/model", apiKey: key, credentialId: null };
  await expect(member.models.setWorkspacePolicy(input)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(owner.models.setWorkspacePolicy(input)).resolves.toEqual({ ok: true });
  expect(JSON.stringify(saved)).not.toContain(key);
  const status = await member.models.workspacePolicy();
  expect(status).toEqual({
    canManage: false,
    policy: { provider: "openrouter", modelId: "test/model" },
  });
  expect(JSON.stringify(status)).not.toContain(key);
  await expect(member.models.setRole({ role: "main", primary: null })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(member.models.clearWorkspacePolicy()).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(owner.models.clearWorkspacePolicy()).resolves.toEqual({ ok: true });
  expect(saved).toBeNull();
});

it("does not return a key echoed by a model discovery endpoint", async () => {
  const key = "private-test-api-key";
  const deps = {
    prisma: {},
    secrets: {},
    env: { agentRuntime: "pi", defaultProvider: "openrouter", defaultModel: "model" },
    modelConnectionFetch: vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: key }, { id: "company-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  } as unknown as RouterDeps;
  const actor = {
    userId: "u",
    spaceId: "s",
    email: "u@example.test",
    isDeploymentOwner: false,
  } satisfies Actor;
  const client = createRouterClient(createRouter(deps), { context: { actor } as never });
  const result = await client.models.probeOpenAiCompatible({
    baseUrl: "https://ollama.com/v1",
    apiKey: key,
    headers: {},
  });
  expect(result.models).toEqual(["company-model"]);
  expect(JSON.stringify(result)).not.toContain(key);
});
