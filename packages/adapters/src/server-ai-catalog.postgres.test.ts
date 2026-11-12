// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { createDb, runAsSystem } from "@orkbot/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { validateBotModelChange } from "./model-selection.js";
import { parseModelSecret, serializeModelSecret } from "./pi-oauth.js";
import { InMemoryRealtimeFanout } from "./realtime.js";
import { resolveConnectedRunModel, resolveRunModel } from "./run-model.js";
import { EncryptedSecretStore } from "./secrets.js";
import { resolveServerAIAuth, retireServerAIAuth } from "./server-ai-auth.js";
import type { AIActor, AIExecutionClaim } from "./server-ai-catalog.js";
import { ServerAICatalog } from "./server-ai-catalog.js";
import { serverAIObserver } from "./server-ai-observer.js";
import { ServerAIModels } from "./server-ai-runtime.js";

const enabled =
  process.env.VERIFY_DATABASE === "1" &&
  Boolean(process.env.COPY_TEST_DATABASE) &&
  Boolean(process.env.DATABASE_URL);
const database = enabled
  ? createDb(process.env.DATABASE_URL!, { encryptContent: false, poolMax: 12 })
  : undefined;
const prisma = database?.prisma;
const system = <T>(run: () => Promise<T>) => runAsSystem("AI catalog PostgreSQL test", run);
const adminKey = "a".repeat(64);
const scopeA = "11111111-1111-4111-8111-111111111111";
const scopeB = "22222222-2222-4222-8222-222222222222";
const revision = "33333333-3333-4333-8333-333333333333";
const admin: AIActor = {
  userId: "ai-test-admin",
  spaceId: "ai-test-a",
  membershipVersion: revision,
};
const member: AIActor = {
  userId: "ai-test-member",
  spaceId: "ai-test-a",
  membershipVersion: revision,
};
const workspaceAdmin: AIActor = {
  userId: "ai-test-workspace-admin",
  spaceId: "ai-test-b",
  membershipVersion: revision,
};
const input = (
  label = "Account",
  concurrencyLimit = 8,
  monthlyBudgetMicros: number | null = null,
) => ({
  label,
  provider: "openai",
  models: ["model-a", "model-b"],
  plaintext: JSON.stringify({ kind: "api_key", key: "fixture-private-api-key" }),
  concurrencyLimit,
  monthlyBudgetMicros,
});

// The fixture principal stands for the session identity check owned by the API composition root.
describe.skipIf(!enabled)("server AI accounts and usage admission on PostgreSQL", () => {
  const secrets = new EncryptedSecretStore(
    "fixture-ai-encryption-key-with-more-than-thirty-two-bytes",
  );
  const realtime = new InMemoryRealtimeFanout();
  const replicas: ServerAICatalog[] = [];
  const replica = () => {
    const catalog = new ServerAICatalog({
      prisma: prisma!,
      secrets,
      realtime,
      principal: async (actor) => (actor.userId === admin.userId ? adminKey : null),
      authorizeWork: async () => ({ signal: new AbortController().signal, dispose() {} }),
    });
    replicas.push(catalog);
    return catalog;
  };
  let catalog: ServerAICatalog;
  beforeEach(async () => {
    for (const item of replicas.splice(0)) item.dispose();
    await system(async () => {
      await prisma!.aIUsageReservation.deleteMany();
      await prisma!.workspaceAIConnection.deleteMany();
      await prisma!.aIWorkspacePolicy.deleteMany();
      await prisma!.serverAIConnection.deleteMany();
      await prisma!.aIConnectionAdministrator.deleteMany();
      await prisma!.centralSessionBinding.deleteMany();
      await prisma!.centralWorkspaceAccess.deleteMany();
      await prisma!.centralWorkspaceBinding.deleteMany();
      await prisma!.installationIdentity.deleteMany();
      await prisma!.organization.deleteMany({ where: { id: "ai-test-org" } });
      await prisma!.user.deleteMany({ where: { id: { startsWith: "ai-test-" } } });
      await prisma!.organization.create({
        data: {
          id: "ai-test-org",
          name: "Organization",
          slug: "ai-test-org",
          createdAt: new Date(),
        },
      });
      for (const spaceId of ["ai-test-a", "ai-test-b"])
        await prisma!.space.create({
          data: { id: spaceId, organizationId: "ai-test-org", name: spaceId },
        });
      for (const actor of [admin, member, workspaceAdmin]) {
        await prisma!.user.create({
          data: {
            id: actor.userId,
            name: actor.userId,
            email: `${actor.userId}@example.test`,
            emailVerified: true,
          },
        });
        await prisma!.member.create({
          data: {
            id: randomUUID(),
            organizationId: "ai-test-org",
            userId: actor.userId,
            role: "member",
            createdAt: new Date(),
          },
        });
        await prisma!.spaceMember.create({
          data: {
            id: randomUUID(),
            organizationId: "ai-test-org",
            spaceId: actor.spaceId,
            userId: actor.userId,
            role: actor === member ? "member" : "admin",
            createdAt: new Date(),
          },
        });
      }
      await prisma!.installationIdentity.create({
        data: {
          id: "local",
          issuer: "https://accounts.example.test",
          publicKey: "fixture-public-key",
          privateKeyCipher: "fixture-sealed-key",
          keyFingerprint: "b".repeat(64),
          operationId: randomUUID(),
          challenge: "c".repeat(43),
          state: "ready",
          serverId: "44444444-4444-4444-8444-444444444444",
          centralOrganizationId: "55555555-5555-4555-8555-555555555555",
          bindingVersion: 1,
        },
      });
      for (const [id, spaceId] of [
        [scopeA, "ai-test-a"],
        [scopeB, "ai-test-b"],
      ])
        await prisma!.centralWorkspaceBinding.create({
          data: {
            id: id!,
            spaceId: spaceId!,
            localOrganizationId: "ai-test-org",
            serverId: "44444444-4444-4444-8444-444444444444",
            centralOrganizationId: "55555555-5555-4555-8555-555555555555",
            operationId: randomUUID(),
            bindingVersion: 1,
            permissionVersion: 1,
            state: "ready",
            members: [],
            verifiedAt: new Date(),
            validUntil: new Date(Date.now() + 300_000),
          },
        });
      for (const actor of [admin, member, workspaceAdmin])
        await prisma!.centralWorkspaceAccess.create({
          data: {
            workspaceId: actor.spaceId === "ai-test-a" ? scopeA : scopeB,
            userId: actor.userId,
            centralSubject: `central-${actor.userId}`,
            membershipVersion: revision,
            role: actor === member ? "member" : "admin",
          },
        });
      await prisma!.aIConnectionAdministrator.create({
        data: { accountKey: adminKey, bindingVersion: 1 },
      });
    });
    catalog = replica();
  });
  afterAll(async () => {
    for (const item of replicas) item.dispose();
    await realtime.close();
    await secrets.close();
    await database?.pool.end();
  });
  const assign = async (
    connectionId: string,
    actor = admin,
    priority = 0,
    budget: number | null = null,
  ) => {
    await catalog.offer(admin, actor.spaceId, connectionId, true);
    await catalog.configure(actor, connectionId, {
      enabled: true,
      allowedModels: ["model-a"],
      defaultModelId: "model-a",
      isDefault: priority === 0,
      fallback: priority > 0,
      priority,
      monthlyBudgetMicros: budget,
    });
  };
  const claimOwners = new WeakMap<AIExecutionClaim, ServerAICatalog>();
  const claim = async (
    connectionId: string,
    actor = member,
    estimatedMicros = 10,
    instance = catalog,
    operationId: string = randomUUID(),
  ) => {
    const result = await instance.claim(actor, {
      operationId,
      connectionId,
      modelId: "model-a",
      estimatedMicros,
    });
    claimOwners.set(result, instance);
    return result;
  };
  const settle = (claim: AIExecutionClaim, cost: number | null) =>
    claimOwners.get(claim)!.settle(claim, cost);

  it("stores multiple accounts of one provider without leaking credentials or unrelated offers", async () => {
    const first = await catalog.create(admin, input("First"));
    const second = await catalog.create(admin, input("Second"));
    expect(first.id).not.toBe(second.id);
    await assign(first.id);
    await catalog.offer(admin, admin.spaceId, second.id, true);
    expect((await catalog.accounts(admin)).map((row) => row.id)).toEqual([first.id, second.id]);
    expect((await catalog.list(member)).map((row) => row.id)).toEqual([first.id]);
    const offered = (await catalog.list(admin)).map((row) => row.id);
    expect(offered).toHaveLength(2);
    expect(offered).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(JSON.stringify(await catalog.list(admin))).not.toMatch(
      /secretRef|secretId|fixture-private-api-key/,
    );
    const stored = await system(() =>
      prisma!.serverAIConnection.findUniqueOrThrow({ where: { id: first.id } }),
    );
    expect(stored.secretRef).not.toContain("fixture-private-api-key");
    await system(() => prisma!.user.delete({ where: { id: admin.userId } }));
    expect((await catalog.list(member))[0]?.id).toBe(first.id);
  });

  it("separates server delegation from workspace administration and rejects unoffered models", async () => {
    await expect(catalog.create(workspaceAdmin, input())).rejects.toMatchObject({
      code: "forbidden",
    });
    const connection = await catalog.create(admin, input());
    await expect(
      catalog.configure(workspaceAdmin, connection.id, {
        enabled: true,
        allowedModels: ["model-a"],
        defaultModelId: "model-a",
        priority: 0,
        monthlyBudgetMicros: null,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await assign(connection.id, workspaceAdmin);
    await expect(
      catalog.configure(member, connection.id, {
        enabled: true,
        allowedModels: ["model-a"],
        defaultModelId: "model-a",
        priority: 0,
        monthlyBudgetMicros: null,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      catalog.configure(workspaceAdmin, connection.id, {
        enabled: true,
        allowedModels: ["another-model"],
        defaultModelId: "another-model",
        priority: 0,
        monthlyBudgetMicros: null,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await catalog.choices(member)).toEqual([]);
    await expect(claim(connection.id)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("uses only installation assignments in the actual runtime model resolvers", async () => {
    const serverAIModels = new ServerAIModels(authDeps());
    const deps = {
      prisma: prisma!,
      secretStore: secrets,
      serverAIModels,
      deploymentModelConfigured: true,
      deploymentModelKey: "unrelated-deployment-secret",
    } as unknown as ExecutorDeps;
    await expect(resolveRunModel(deps, member)).rejects.toMatchObject({ code: "unavailable" });
    const account = await catalog.create(admin, input());
    await assign(account.id);
    const main = await resolveRunModel(deps, member);
    expect(main).toMatchObject({ connectionId: account.id, apiKey: "fixture-private-api-key" });
    expect(main.callObserver).toBeDefined();
    expect(await serverAIModels.fallbacks(member)).toEqual([]);
    await expect(
      resolveConnectedRunModel(
        deps,
        member,
        "openai",
        "model-a",
        undefined,
        true,
        null,
        "unassigned-account",
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      resolveRunModel(deps, {
        ...member,
        centralWorkspaceId: scopeA,
        workspaceMembershipVersion: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await catalog.offer(admin, member.spaceId, account.id, false);
    await expect(resolveRunModel(deps, member)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("serializes only the shared account capacity across workspaces and replicas", async () => {
    const connection = await catalog.create(admin, input("Shared", 1));
    await assign(connection.id);
    await assign(connection.id, workspaceAdmin);
    const results = await Promise.allSettled([
      claim(connection.id),
      claim(connection.id, workspaceAdmin, 10, replica()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "busy" } },
    ]);
    for (const result of results) if (result.status === "fulfilled") await settle(result.value, 10);
    const other = await claim(connection.id, workspaceAdmin);
    await settle(other, 10);
  });

  it("keeps explicit selections separate from default and fallback permissions", async () => {
    const first = await catalog.create(admin, input("Default"));
    const second = await catalog.create(admin, input("Explicit only"));
    await assign(first.id);
    await catalog.offer(admin, admin.spaceId, second.id, true);
    await catalog.configure(admin, second.id, {
      enabled: true,
      allowedModels: ["model-a"],
      defaultModelId: "model-a",
      priority: 0,
      monthlyBudgetMicros: null,
    });
    expect(await catalog.choices(member)).toEqual([{ connectionId: first.id, modelId: "model-a" }]);
    await settle(await claim(second.id), 0);
    await catalog.configure(admin, second.id, {
      enabled: true,
      allowedModels: ["model-a"],
      defaultModelId: "model-a",
      isDefault: true,
      priority: 0,
      monthlyBudgetMicros: null,
    });
    expect(await catalog.choices(member)).toEqual([
      { connectionId: second.id, modelId: "model-a" },
    ]);
    await catalog.configure(admin, second.id, {
      enabled: true,
      allowedModels: ["model-a"],
      defaultModelId: "model-a",
      isDefault: false,
      priority: 0,
      monthlyBudgetMicros: null,
    });
    await assign(first.id);
    await catalog.disable(admin, first.id);
    expect(await catalog.choices(member)).toEqual([]);
    expect((await catalog.list(member)).find((row) => row.id === first.id)?.state).toBe("disabled");
    await catalog.configure(admin, first.id, {
      enabled: false,
      allowedModels: ["model-a"],
      defaultModelId: "model-a",
      priority: 0,
      monthlyBudgetMicros: null,
    });
    expect((await catalog.list(member)).map((row) => row.id)).toEqual([second.id]);
  });

  it("removes models retired by the server administrator from member discovery and automatic choices", async () => {
    const primary = await catalog.create(admin, input("Primary"));
    const backup = await catalog.create(admin, input("Backup"));
    await assign(primary.id);
    await assign(backup.id, admin, 1);
    await catalog.update(admin, primary.id, {
      label: "Primary",
      models: ["model-b"],
      concurrencyLimit: 8,
      monthlyBudgetMicros: null,
    });
    expect((await catalog.list(member)).map((row) => row.id)).toEqual([backup.id]);
    expect((await catalog.list(admin)).find((row) => row.id === primary.id)?.models).toEqual([
      "model-b",
    ]);
    expect(await catalog.choices(admin)).toEqual([{ connectionId: backup.id, modelId: "model-a" }]);
    const runtime = new ServerAIModels(authDeps());
    const selected = await runtime.resolve(member);
    expect(selected?.model.connectionId).toBe(backup.id);
    await selected?.dispose();
    await expect(claim(primary.id)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("honors two bots' exact account pins and rejects a revoked pin before execution", async () => {
    const primary = await catalog.create(admin, input("Primary"));
    const alternate = await catalog.create(admin, {
      ...input("Alternate"),
      plaintext: JSON.stringify({ kind: "api_key", key: "fixture-alternate-key" }),
    });
    await assign(primary.id);
    await assign(alternate.id, admin, 1);
    const runtime = new ServerAIModels(authDeps());
    const deps = {
      prisma: prisma!,
      secretStore: secrets,
      serverAIModels: runtime,
    } as unknown as ExecutorDeps;
    const bots = await system(() =>
      Promise.all(
        [primary, alternate].map((account) =>
          prisma!.bot.create({
            data: {
              spaceId: member.spaceId,
              userId: member.userId,
              name: account.label,
              color: "blue",
              modelProvider: "openai",
              modelId: "model-a",
              modelConnectionId: account.id,
            },
          }),
        ),
      ),
    );
    for (const [index, bot] of bots.entries()) {
      const model = await system(() => resolveRunModel(deps, { ...member, botId: bot.id }));
      expect(model.connectionId).toBe(index === 0 ? primary.id : alternate.id);
      expect(model.apiKey).toBe(index === 0 ? "fixture-private-api-key" : "fixture-alternate-key");
    }
    const validationDeps = {
      prisma: prisma!,
      secretStore: secrets,
      serverAIModels: runtime,
      refreshExpiredCredential() {},
      defaultModel: async () => ({ provider: null, model: null }),
    };
    await expect(
      validateBotModelChange(validationDeps, {
        ...member,
        provider: "openai",
        model: "model-a",
        connectionId: alternate.id,
      }),
    ).resolves.toMatchObject({ ok: true });
    await catalog.offer(admin, member.spaceId, alternate.id, false);
    await expect(
      system(() => resolveRunModel(deps, { ...member, botId: bots[1]!.id })),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      validateBotModelChange(validationDeps, {
        ...member,
        provider: "openai",
        model: "model-a",
        connectionId: alternate.id,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      runtime.validateSelection(workspaceAdmin, {
        provider: "openai",
        modelId: "model-a",
        connectionId: primary.id,
      }),
    ).resolves.toBe(false);
    await expect(runtime.resolve(member)).resolves.toMatchObject({
      model: { connectionId: primary.id },
    });
  });

  it("serializes concurrent default changes without leaving the workspace unconfigured", async () => {
    const first = await catalog.create(admin, input("First"));
    const second = await catalog.create(admin, input("Second"));
    await assign(first.id);
    await catalog.offer(admin, admin.spaceId, second.id, true);
    const configure = (instance: ServerAICatalog, id: string) =>
      instance.configure(admin, id, {
        enabled: true,
        allowedModels: ["model-a"],
        defaultModelId: "model-a",
        isDefault: true,
        fallback: false,
        priority: 0,
        monthlyBudgetMicros: 123,
      });
    await Promise.all([configure(catalog, first.id), configure(replica(), second.id)]);
    const defaults = (await catalog.list(admin)).filter((row) => row.enabled && row.isDefault);
    expect(defaults).toHaveLength(1);
    expect([first.id, second.id]).toContain(defaults[0]!.id);
    expect(await catalog.choices(member)).toHaveLength(1);
    expect(defaults[0]!.monthlyBudgetMicros).toBe(123);
  });

  it("falls back after initial authentication failure only to an explicitly permitted account", async () => {
    const primary = await catalog.create(admin, input("Broken primary"));
    const backup = await catalog.create(admin, input("Allowed fallback"));
    const explicit = await catalog.create(admin, input("Explicit only"));
    await assign(primary.id);
    await assign(backup.id, admin, 1);
    await catalog.offer(admin, admin.spaceId, explicit.id, true);
    await catalog.configure(admin, explicit.id, {
      enabled: true,
      allowedModels: ["model-a"],
      defaultModelId: "model-a",
      priority: 0,
      monthlyBudgetMicros: null,
    });
    await system(() =>
      prisma!.serverAIConnection.update({
        where: { id: primary.id },
        data: { secretRef: "invalid-encrypted-secret" },
      }),
    );
    const runtime = new ServerAIModels(authDeps());
    const resolved = await runtime.resolve(member);
    expect(resolved?.model.connectionId).toBe(backup.id);
    await resolved?.dispose();
    await expect(
      runtime.resolve(member, { provider: "openai", modelId: "model-a", connectionId: primary.id }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await catalog.disable(admin, backup.id);
    await expect(runtime.resolve(member)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("shares a provider quota cooldown across replicas and workspaces, without blocking another account", async () => {
    const first = await catalog.create(admin, input("Rate limited"));
    const other = await catalog.create(admin, input("Independent"));
    await assign(first.id);
    await assign(first.id, workspaceAdmin);
    await assign(other.id);
    const observer = serverAIObserver(catalog, member, first.id, "model-a", "openai");
    const id = await observer.beforeCall({
      callId: randomUUID(),
      provider: "openai",
      modelId: "model-a",
      inputTokensEstimate: 1,
      maxOutputTokens: 1,
      maxCostUsd: 0,
    });
    await observer.onResponse!(id, { status: 429, retryAfter: "120" });
    await observer.afterCall(id, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    const secondReplica = replica();
    await expect(claim(first.id, workspaceAdmin, 0, secondReplica)).rejects.toMatchObject({
      code: "busy",
    });
    await settle(await claim(other.id), 0);
    const blocked = await system(() =>
      prisma!.serverAIConnection.findUniqueOrThrow({ where: { id: first.id } }),
    );
    expect(blocked.blockedUntil!.getTime() - Date.now()).toBeGreaterThan(110_000);
    await catalog.reconnect(
      admin,
      first.id,
      JSON.stringify({ kind: "api_key", key: "replacement-key" }),
    );
    await expect(claim(first.id)).rejects.toMatchObject({ code: "busy" });
    await system(() =>
      prisma!.serverAIConnection.update({
        where: { id: first.id },
        data: { blockedUntil: new Date(0) },
      }),
    );
    await settle(await claim(first.id), 0);
    await observer.dispose();
  });

  it("reconciles an unknown charge once when a delayed provider receipt arrives", async () => {
    const connection = await catalog.create(admin, input());
    await assign(connection.id);
    const reserved = await claim(connection.id);
    await settle(reserved, null);
    const initial = await system(() =>
      prisma!.aIUsageReservation.findUniqueOrThrow({
        where: { operationId: reserved.operationId },
      }),
    );
    await settle(reserved, 7);
    await settle(reserved, 999);
    const reconciled = await system(() =>
      prisma!.aIUsageReservation.findUniqueOrThrow({
        where: { operationId: reserved.operationId },
      }),
    );
    expect(reconciled.chargedMicros).toBe(7n);
    expect(reconciled.completedAt).toEqual(initial.completedAt);
  });

  it("reserves monthly budgets atomically and retains unknown spend after a lost lease", async () => {
    const connection = await catalog.create(admin, input("Budget", 8, 100));
    await assign(connection.id);
    await assign(connection.id, workspaceAdmin);
    const results = await Promise.allSettled([
      claim(connection.id, member, 70),
      claim(connection.id, workspaceAdmin, 70, replica()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "budget" } },
    ]);
    const completed = results.find(
      (result) => result.status === "fulfilled",
    ) as PromiseFulfilledResult<AIExecutionClaim>;
    await settle(completed.value, null);
    await expect(claim(connection.id, member, 31)).rejects.toMatchObject({ code: "budget" });
    const final = await claim(connection.id, member, 30);
    await settle(final, 12);
    expect(await system(() => prisma!.aIUsageReservation.count())).toBe(2);
  });

  it("applies a workspace budget across different accounts and rejects duplicate operations", async () => {
    const first = await catalog.create(admin, input("First"));
    const second = await catalog.create(admin, input("Second"));
    await assign(first.id);
    await assign(second.id, admin, 1);
    await catalog.setWorkspaceBudget(admin, 100);
    const results = await Promise.allSettled([
      claim(first.id, member, 60),
      claim(second.id, member, 60, replica()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "budget" } },
    ]);
    const success = results.find(
      (result) => result.status === "fulfilled",
    ) as PromiseFulfilledResult<AIExecutionClaim>;
    await expect(
      claim(success.value.connectionId, member, 60, replica(), success.value.operationId),
    ).rejects.toMatchObject({ code: "conflict" });
    await settle(success.value, 20);
    await settle(success.value, 999);
    expect(
      (
        await system(() =>
          prisma!.aIUsageReservation.findUniqueOrThrow({
            where: { operationId: success.value.operationId },
          }),
        )
      ).chargedMicros,
    ).toBe(20n);
  });

  it("revokes a selected account before queued execution without falling back to an unrelated account", async () => {
    const first = await catalog.create(admin, input("First"));
    const second = await catalog.create(admin, input("Second"));
    await assign(first.id);
    await assign(second.id, admin, 1);
    const running = await claim(first.id);
    const unrelated = await claim(second.id);
    await catalog.offer(admin, admin.spaceId, first.id, false);
    expect(running.signal.aborted).toBe(true);
    expect(unrelated.signal.aborted).toBe(false);
    await expect(catalog.validate(running)).rejects.toThrow();
    await expect(claim(first.id)).rejects.toMatchObject({ code: "forbidden" });
    expect(await catalog.choices(member)).toEqual([
      { connectionId: second.id, modelId: "model-a" },
    ]);
    await settle(running, null);
    await settle(unrelated, 10);
  });

  it("does not restore account assignments or administrator delegation after a server rebind", async () => {
    const connection = await catalog.create(admin, input());
    await assign(connection.id);
    await system(async () => {
      await prisma!.installationIdentity.update({
        where: { id: "local" },
        data: { bindingVersion: 2 },
      });
      await prisma!.centralWorkspaceBinding.update({
        where: { id: scopeA },
        data: { bindingVersion: 2 },
      });
    });
    await expect(catalog.accounts(admin)).rejects.toMatchObject({ code: "forbidden" });
    expect(await catalog.list(member)).toEqual([]);
    await expect(claim(connection.id)).rejects.toMatchObject({ code: "forbidden" });
  });
  const expired = (accountId: string): OAuthCredential => ({
    type: "oauth",
    access: "old-access",
    refresh: "old-refresh",
    expires: Date.now() - 1000,
    accountId,
  });
  const oauthAccount = (accountId: string) =>
    catalog.create(admin, {
      ...input(accountId),
      plaintext: serializeModelSecret({ kind: "oauth", credential: expired(accountId) }),
    });
  const authDeps = (instance = catalog) => ({ prisma: prisma!, secrets, catalog: instance });

  it("refreshes one shared provider account once across workspaces and replicas", async () => {
    const account = await oauthAccount("external-a");
    await assign(account.id);
    await assign(account.id, workspaceAdmin);
    const oauth: Pick<OAuthAuth, "refresh" | "toAuth"> = {
      refresh: vi.fn(async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          ...current,
          access: "fresh-access",
          refresh: "fresh-refresh",
          expires: Date.now() + 3_600_000,
        };
      }),
      toAuth: async (current) => ({ apiKey: current.access }),
    };
    const resolved = await Promise.all([
      resolveServerAIAuth(authDeps(), member, account.id, "model-a", { oauth }),
      resolveServerAIAuth(authDeps(replica()), workspaceAdmin, account.id, "model-a", { oauth }),
    ]);
    expect(oauth.refresh).toHaveBeenCalledOnce();
    expect(resolved.map((value) => value.value.apiKey)).toEqual(["fresh-access", "fresh-access"]);
    const stored = await system(() =>
      prisma!.serverAIConnection.findUniqueOrThrow({ where: { id: account.id } }),
    );
    expect(stored.credentialVersion).toBe(2);
    expect(stored.revision).toBe(1);
    expect(parseModelSecret(await secrets.load(stored.secretRef, stored.secretId))).toMatchObject({
      credential: { refresh: "fresh-refresh" },
    });
  });

  it("does not retire a newer rotation after a stale runtime rejection", async () => {
    const account = await oauthAccount("external-a");
    await assign(account.id);
    const before = await system(() =>
      prisma!.serverAIConnection.findUniqueOrThrow({ where: { id: account.id } }),
    );
    const stored = parseModelSecret(await secrets.load(before.secretRef, before.secretId));
    if (stored.kind !== "oauth" || stored.reconnectRequired)
      throw new Error("Expected OAuth fixture");
    const fresh = {
      ...stored.credential,
      access: "new-access",
      refresh: "new-refresh",
      expires: Date.now() + 3_600_000,
    };
    const oauth: Pick<OAuthAuth, "refresh" | "toAuth"> = {
      refresh: async () => fresh,
      toAuth: async (current) => ({ apiKey: current.access }),
    };
    await resolveServerAIAuth(authDeps(), member, account.id, "model-a", { oauth });
    expect(
      await retireServerAIAuth(authDeps(), member, account.id, "model-a", stored.credential),
    ).toBe(false);
    expect(await retireServerAIAuth(authDeps(), member, account.id, "model-a")).toBe(false);
    expect(await retireServerAIAuth(authDeps(), member, account.id, "model-a", fresh)).toBe(true);
    expect((await catalog.list(member))[0]?.state).toBe("reconnect-required");
  });

  it("allows different accounts of one provider to refresh concurrently", async () => {
    const first = await oauthAccount("external-a");
    const second = await oauthAccount("external-b");
    await assign(first.id);
    await assign(second.id, admin, 1);
    let active = 0;
    let maximum = 0;
    const oauth: Pick<OAuthAuth, "refresh" | "toAuth"> = {
      refresh: async (current) => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active--;
        return {
          ...current,
          access: `fresh-${current.accountId}`,
          expires: Date.now() + 3_600_000,
        };
      },
      toAuth: async (current) => ({ apiKey: current.access }),
    };
    await Promise.all([
      resolveServerAIAuth(authDeps(), member, first.id, "model-a", { oauth }),
      resolveServerAIAuth(authDeps(replica()), member, second.id, "model-a", { oauth }),
    ]);
    expect(maximum).toBe(2);
  });

  it("commits a successful rotation before reporting a provider formatter failure without disclosing its error", async () => {
    const account = await oauthAccount("external-a");
    await assign(account.id);
    const oauth: Pick<OAuthAuth, "refresh" | "toAuth"> = {
      refresh: async (current) => ({
        ...current,
        access: "fresh-access",
        refresh: "fresh-refresh",
        expires: Date.now() + 3_600_000,
      }),
      toAuth: async () => {
        throw new Error("Provider echoed fixture-private-api-key");
      },
    };
    await expect(
      resolveServerAIAuth(authDeps(), member, account.id, "model-a", { oauth }),
    ).rejects.toThrow("AI connection unavailable");
    const row = await system(() =>
      prisma!.serverAIConnection.findUniqueOrThrow({ where: { id: account.id } }),
    );
    expect(row.credentialVersion).toBe(2);
    expect(parseModelSecret(await secrets.load(row.secretRef, row.secretId))).toMatchObject({
      credential: { refresh: "fresh-refresh" },
    });
  });

  it("retires a rejected or changed provider identity without selecting another account", async () => {
    const account = await oauthAccount("external-a");
    await assign(account.id);
    const oauth: Pick<OAuthAuth, "refresh" | "toAuth"> = {
      refresh: async () => {
        throw new Error('Token refresh failed (400): {"error":"refresh_token_reused"}');
      },
      toAuth: async (current) => ({ apiKey: current.access }),
    };
    await expect(
      resolveServerAIAuth(authDeps(), member, account.id, "model-a", { oauth }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(
      (
        await system(() =>
          prisma!.serverAIConnection.findUniqueOrThrow({ where: { id: account.id } }),
        )
      ).state,
    ).toBe("reconnect-required");
    expect(await catalog.choices(member)).toEqual([]);
  });

  it("checks and reserves each provider call through the existing runtime observer", async () => {
    const account = await catalog.create(admin, input());
    await assign(account.id);
    const observer = serverAIObserver(catalog, member, account.id, "model-a", "openai");
    const id = await observer.beforeCall({
      callId: randomUUID(),
      provider: "openai",
      modelId: "model-a",
      inputTokensEstimate: 1,
      maxOutputTokens: 1,
      maxCostUsd: 0.00001,
    });
    expect(observer.signalForCall!(id)?.aborted).toBe(false);
    await catalog.offer(admin, admin.spaceId, account.id, false);
    expect(observer.signalForCall!(id)?.aborted).toBe(true);
    await observer.afterCall(id, {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      costUsd: 0.000005,
    });
    expect(
      (
        await system(() =>
          prisma!.aIUsageReservation.findUniqueOrThrow({ where: { operationId: id } }),
        )
      ).chargedMicros,
    ).toBe(5n);
    await observer.dispose();
  });

  it("requires a known maximum cost when a budget is enabled and retains unknown receipts", async () => {
    const account = await catalog.create(admin, input());
    await assign(account.id);
    const observer = serverAIObserver(catalog, member, account.id, "model-a", "openai");
    const call = {
      provider: "openai",
      modelId: "model-a",
      inputTokensEstimate: 1,
      maxOutputTokens: 1,
    };
    const id = await observer.beforeCall(call);
    await observer.afterCall(id, null);
    await catalog.setWorkspaceBudget(admin, 100);
    await expect(observer.beforeCall({ ...call, maxCostUsd: 0.00001 })).rejects.toMatchObject({
      code: "budget",
    });
    await expect(observer.beforeCall(call)).rejects.toMatchObject({ code: "budget" });
    await observer.dispose();
  });
});
