// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { EncryptedSecretStore, resolveWorkspaceModel } from "@orkbot/adapters";
import type { Actor } from "@orkbot/contracts";
import { createDb, runAsSystem, runAsTenant } from "@orkbot/db";
import { createRouterClient } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const postgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe.sequential
    : describe.skip;
function workspaceClient(router: ReturnType<typeof createRouter>, userId: string, spaceId: string) {
  return createRouterClient(router, {
    context: {
      actor: {
        userId,
        spaceId,
        email: `${userId}@example.test`,
        isDeploymentOwner: false,
      } satisfies Actor,
    } as never,
  });
}
postgres("workspace model API with PostgreSQL", () => {
  const tag = `${process.pid}-${Date.now()}`;
  const organizationId = `workspace-policy-${tag}`;
  const spaceId = `space-${tag}`;
  const ownerId = `owner-${tag}`;
  const memberId = `member-${tag}`;
  const secret = "private-test-workspace-key";
  let ownerDb: ReturnType<typeof createDb>;
  let runtimeDb: ReturnType<typeof createDb>;
  const secretStore = new EncryptedSecretStore("test-encryption-key-for-workspace-model-tests");
  let owner: ReturnType<typeof workspaceClient>;
  let member: typeof owner;
  beforeAll(async () => {
    ownerDb = createDb(migrationUrl!);
    runtimeDb = createDb(runtimeUrl!);
    await ownerDb.prisma.organization.create({
      data: { id: organizationId, name: "Test", slug: organizationId, createdAt: new Date() },
    });
    await ownerDb.prisma.space.create({ data: { id: spaceId, name: "Test", organizationId } });
    for (const [userId, role] of [
      [ownerId, "owner"],
      [memberId, "member"],
    ] as const) {
      await ownerDb.prisma.user.create({
        data: { id: userId, name: userId, email: `${userId}@example.test`, emailVerified: true },
      });
      await ownerDb.prisma.member.create({
        data: { id: `membership-${userId}`, organizationId, userId, role, createdAt: new Date() },
      });
      await ownerDb.prisma.spaceMember.create({
        data: {
          id: `space-member-${userId}`,
          organizationId,
          userId,
          role,
          spaceId,
          createdAt: new Date(),
        },
      });
    }
    const deps = {
      prisma: runtimeDb.prisma,
      secrets: secretStore,
      env: { agentRuntime: "pi", defaultProvider: "openrouter", defaultModel: "model" },
      modelConnectionFetch: vi.fn(async () => new Response("{}", { status: 200 })),
    } as unknown as RouterDeps;
    const router = createRouter(deps);
    owner = workspaceClient(router, ownerId, spaceId);
    member = workspaceClient(router, memberId, spaceId);
  });
  afterAll(async () => {
    await ownerDb.prisma.organization.deleteMany({ where: { id: organizationId } });
    await ownerDb.prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
    await Promise.all([ownerDb.pool.end(), runtimeDb.pool.end(), secretStore.close()]);
  });
  it("stores an owner-configured key encrypted and runs the same model for another member", async () => {
    await expect(
      owner.models.setWorkspacePolicy({
        provider: "openrouter",
        modelId: "example/model",
        apiKey: secret,
        credentialId: null,
      }),
    ).resolves.toEqual({ ok: true });
    const stored = await runAsSystem("inspect test workspace model", () =>
      ownerDb.prisma.workspaceModelPolicy.findUniqueOrThrow({ where: { organizationId } }),
    );
    expect(stored.secretRef).not.toContain(secret);
    const status = await member.models.workspacePolicy();
    expect(status).toEqual({
      canManage: false,
      policy: { provider: "openrouter", modelId: "example/model" },
    });
    expect(JSON.stringify(status)).not.toContain(secret);
    const resolved = await runAsTenant({ userId: memberId, spaceId }, () =>
      resolveWorkspaceModel({ prisma: runtimeDb.prisma, secretStore }, spaceId),
    );
    expect(resolved?.model).toMatchObject({
      provider: "openrouter",
      id: "example/model",
      apiKey: secret,
    });
    await expect(member.models.clearWorkspacePolicy()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.models.setRole({ role: "main", primary: null })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it("keeps the shared credential when its owner is removed", async () => {
    await ownerDb.prisma.user.delete({ where: { id: ownerId } });
    const resolved = await runAsTenant({ userId: memberId, spaceId }, () =>
      resolveWorkspaceModel({ prisma: runtimeDb.prisma, secretStore }, spaceId),
    );
    expect(resolved?.model).toMatchObject({
      provider: "openrouter",
      id: "example/model",
      apiKey: secret,
    });
  });
});
