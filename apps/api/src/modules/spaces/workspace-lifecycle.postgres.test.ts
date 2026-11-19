// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JobPublisher, SecretStore } from "@orkbot/adapter-kit";
import {
  FakeSandboxProvider,
  LocalAgentHomeStore,
  LocalArtifactStore,
  suspendWorkspaceComputers,
} from "@orkbot/adapters";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@orkbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimManagedSpace, deleteClaimedManagedSpace } from "./workspace-lifecycle-deletion.js";
import {
  claimWorkspaceLifecycleReceipt,
  completeWorkspaceLifecycleReceipt,
} from "./workspace-lifecycle-receipt.js";
import { removeManagedWorkspace } from "./workspace-lifecycle-remove.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && url ? describe : describe.skip;

describePostgres.sequential("managed workspace lifecycle on PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  const cleanup: Array<() => Promise<unknown>> = [];
  beforeAll(() => {
    db = createDb(url!, { encryptContent: false });
  });
  afterAll(async () => {
    for (const action of cleanup.reverse()) await action();
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("keeps the deletion receipt isolated, deletes children first, and survives a lost acknowledgement", async () => {
    const prisma = asSystem(db.prisma);
    const localOrg = randomUUID();
    const root = randomUUID();
    const child = randomUUID();
    const other = randomUUID();
    const workspaceId = randomUUID();
    const configuration = {
      serverId: randomUUID(),
      organizationId: randomUUID(),
      bindingVersion: 1,
      keyFingerprint: "f".repeat(64),
    };
    const operation = {
      operationId: randomUUID(),
      workspaceId,
      permissionVersion: 2,
      kind: "delete" as const,
      localOrganizationId: localOrg,
      localWorkspaceId: root,
    };
    cleanup.push(async () => {
      await prisma.workspaceLifecycleReceipt.deleteMany({
        where: { operationId: operation.operationId },
      });
      await prisma.centralWorkspaceBinding.deleteMany({ where: { id: workspaceId } });
      await prisma.installationIdentity.deleteMany({
        where: { id: "local", serverId: configuration.serverId },
      });
      await prisma.organization.deleteMany({ where: { id: localOrg } });
    });
    await prisma.organization.create({
      data: { id: localOrg, name: "test", slug: localOrg, createdAt: new Date() },
    });
    await prisma.space.createMany({
      data: [
        { id: root, organizationId: localOrg, name: "root", isDefault: true },
        { id: child, organizationId: localOrg, name: "child", admissionWorkspaceId: workspaceId },
        { id: other, organizationId: localOrg, name: "other" },
      ],
    });
    await prisma.installationIdentity.create({
      data: {
        id: "local",
        issuer: "https://accounts.example.test",
        publicKey: "fixture",
        privateKeyCipher: "fixture",
        operationId: randomUUID(),
        challenge: "fixture",
        state: "ready",
        serverId: configuration.serverId,
        centralOrganizationId: configuration.organizationId,
        bindingVersion: 1,
        keyFingerprint: configuration.keyFingerprint,
      },
    });
    await prisma.centralWorkspaceBinding.create({
      data: {
        id: workspaceId,
        serverId: configuration.serverId,
        centralOrganizationId: configuration.organizationId,
        localOrganizationId: localOrg,
        spaceId: root,
        operationId: randomUUID(),
        bindingVersion: 1,
        permissionVersion: 2,
        state: "disabled",
        members: [],
        verifiedAt: new Date(),
        validUntil: new Date(Date.now() + 300_000),
      },
    });
    const claimed = await claimWorkspaceLifecycleReceipt(db.prisma, configuration, operation);
    expect(claimed && !claimed.complete).toBe(true);
    if (!claimed || claimed.complete) throw new Error("missing claim");
    expect(claimed.spaceIds.sort()).toEqual([root, child].sort());
    expect(await claimWorkspaceLifecycleReceipt(db.prisma, configuration, operation)).toBeNull();
    expect(
      await runAsTenant({ spaceId: other, userId: "other-user" }, () =>
        db.prisma.workspaceLifecycleReceipt.findMany(),
      ),
    ).toEqual([]);
    await expect(
      claimWorkspaceLifecycleReceipt(db.prisma, configuration, {
        ...operation,
        localWorkspaceId: other,
      }),
    ).rejects.toThrow("receipt does not match");
    const parentClaim = {
      operationId: operation.operationId,
      claimId: claimed.claimId,
      spaceId: root,
    };
    const childClaim = { ...parentClaim, spaceId: child };
    await claimManagedSpace(db.prisma, parentClaim);
    await claimManagedSpace(db.prisma, childClaim);
    await expect(deleteClaimedManagedSpace(db.prisma, parentClaim)).rejects.toThrow(
      "spaces still remain",
    );
    await deleteClaimedManagedSpace(db.prisma, childClaim);
    await deleteClaimedManagedSpace(db.prisma, parentClaim);
    await completeWorkspaceLifecycleReceipt(db.prisma, operation.operationId, claimed.claimId);
    expect(await claimWorkspaceLifecycleReceipt(db.prisma, configuration, operation)).toEqual({
      complete: true,
      spaceIds: expect.arrayContaining([root, child]),
    });
    expect(await prisma.space.findUnique({ where: { id: other } })).not.toBeNull();
  });

  it("removes a real bot, its home and artifacts while preserving another workspace", async () => {
    const prisma = asSystem(db.prisma);
    await prisma.installationIdentity.deleteMany({
      where: { id: "local", issuer: "https://accounts.example.test" },
    });
    const identity = await provisionMessagingIdentity(
      prisma,
      { provider: "email", address: `lifecycle-${randomUUID()}@example.test` },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    const root = identity.spaceId;
    const rootSpace = await prisma.space.findUniqueOrThrow({ where: { id: root } });
    const computer = await prisma.computer.findFirstOrThrow({ where: { spaceId: root } });
    const workspaceId = randomUUID();
    const other = randomUUID();
    const configuration = {
      serverId: randomUUID(),
      organizationId: randomUUID(),
      bindingVersion: 1,
      keyFingerprint: "e".repeat(64),
    };
    const operation = {
      operationId: randomUUID(),
      workspaceId,
      kind: "delete" as const,
      permissionVersion: 3,
      localOrganizationId: rootSpace.organizationId,
      localWorkspaceId: root,
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-lifecycle-test-"));
    const home = new LocalAgentHomeStore(dataDir);
    const artifacts = new LocalArtifactStore(dataDir);
    const sandbox = new FakeSandboxProvider();
    cleanup.push(async () => {
      await prisma.workspaceLifecycleReceipt.deleteMany({
        where: { operationId: operation.operationId },
      });
      await prisma.centralWorkspaceBinding.deleteMany({ where: { id: workspaceId } });
      await prisma.installationIdentity.deleteMany({
        where: { id: "local", serverId: configuration.serverId },
      });
      await prisma.organization.deleteMany({ where: { id: rootSpace.organizationId } });
      await prisma.user.deleteMany({ where: { id: identity.userId } });
      await rm(dataDir, { recursive: true, force: true });
      sandbox.close();
    });
    await prisma.space.create({
      data: { id: other, organizationId: rootSpace.organizationId, name: "other" },
    });
    await prisma.installationIdentity.create({
      data: {
        id: "local",
        issuer: "https://accounts.example.test",
        publicKey: "fixture",
        privateKeyCipher: "fixture",
        operationId: randomUUID(),
        challenge: "fixture",
        state: "ready",
        serverId: configuration.serverId,
        centralOrganizationId: configuration.organizationId,
        bindingVersion: 1,
        keyFingerprint: configuration.keyFingerprint,
      },
    });
    await prisma.centralWorkspaceBinding.create({
      data: {
        id: workspaceId,
        serverId: configuration.serverId,
        centralOrganizationId: configuration.organizationId,
        localOrganizationId: rootSpace.organizationId,
        spaceId: root,
        operationId: randomUUID(),
        bindingVersion: 1,
        permissionVersion: 3,
        state: "ready",
        members: [],
        verifiedAt: new Date(),
        validUntil: new Date(Date.now() + 300_000),
      },
    });
    await prisma.centralWorkspaceAccess.create({
      data: {
        workspaceId,
        userId: identity.userId,
        centralSubject: "fixture-subject",
        role: "admin",
        membershipVersion: randomUUID(),
        active: true,
      },
    });
    const task = await prisma.task.create({
      data: {
        spaceId: root,
        userId: identity.userId,
        botId: identity.botId,
        threadId: identity.threadId,
        prompt: "fixture",
        status: "running",
      },
    });
    const abandoned = await prisma.run.create({
      data: {
        spaceId: root,
        userId: identity.userId,
        botId: identity.botId,
        threadId: identity.threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "gone",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.centralWorkspaceBinding.update({
      where: { id: workspaceId },
      data: { state: "disabled" },
    });
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId: root,
      userId: identity.userId,
      signal: new AbortController().signal,
    };
    const ref = await sandbox.provision(
      { botId: computer.homeKey, homePath: home.pathFor(computer.homeKey) },
      context,
    );
    await sandbox.writeFile(
      ref,
      { path: "workspace-data", content: Buffer.from("private data") },
      context,
    );
    await prisma.computer.update({
      where: { id: computer.id },
      data: { kind: "fake", state: "running", providerRef: ref.providerRef },
    });
    expect(
      await suspendWorkspaceComputers(
        { prisma: db.prisma, sandbox, home },
        configuration,
        { ...operation, kind: "archive" },
        new AbortController().signal,
      ),
    ).toBe(false);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: abandoned.id } })).status).toBe(
      "cancelled",
    );
    expect(
      await suspendWorkspaceComputers(
        { prisma: db.prisma, sandbox, home },
        configuration,
        { ...operation, kind: "archive" },
        new AbortController().signal,
      ),
    ).toBe(true);
    expect(await sandbox.isRunning(ref, context)).toBe(false);
    expect(Buffer.from(await sandbox.readFile(ref, "workspace-data", context)).toString()).toBe(
      "private data",
    );
    await mkdir(home.pathFor(computer.homeKey), { recursive: true });
    await writeFile(path.join(home.pathFor(computer.homeKey), "workspace-data"), "private data");
    for (const spaceId of [root, other]) {
      await mkdir(path.join(dataDir, "artifacts", spaceId), { recursive: true });
      await writeFile(path.join(dataDir, "artifacts", spaceId, "orphan-file"), "artifact data");
    }
    const deps = {
      prisma: db.prisma,
      home,
      artifacts,
      dataDir,
      sandbox,
      jobs: {
        cancel: async () => undefined,
        enqueue: async () => undefined,
        close: async () => undefined,
      } as JobPublisher,
      secrets: { delete: async () => undefined } as unknown as SecretStore,
    };
    const secretId = randomUUID();
    await prisma.secret.create({
      data: {
        id: secretId,
        userId: identity.userId,
        spaceId: root,
        kind: "memory",
        ciphertext: "fixture",
      },
    });
    await prisma.spaceMemoryConfig.create({
      data: {
        spaceId: root,
        userId: identity.userId,
        provider: "fixture",
        settings: {},
        secretId,
      },
    });
    await expect(
      runAsSystem("test managed deletion guard", () =>
        removeManagedWorkspace(deps, configuration, operation, new AbortController().signal),
      ),
    ).rejects.toThrow("cannot yet remove configured external memory");
    expect(await prisma.bot.findUnique({ where: { id: identity.botId } })).not.toBeNull();
    await prisma.spaceMemoryConfig.delete({ where: { spaceId: root } });
    await prisma.secret.delete({ where: { id: secretId } });
    expect(
      await runAsSystem("test managed deletion", () =>
        removeManagedWorkspace(deps, configuration, operation, new AbortController().signal),
      ),
    ).toBe(true);
    expect(await prisma.space.findUnique({ where: { id: root } })).toBeNull();
    expect(await prisma.bot.findUnique({ where: { id: identity.botId } })).toBeNull();
    await expect(stat(home.pathFor(computer.homeKey))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(dataDir, "artifacts", root))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await stat(path.join(dataDir, "artifacts", other, "orphan-file"))).toBeDefined();
    expect(await prisma.space.findUnique({ where: { id: other } })).not.toBeNull();
  });
});
