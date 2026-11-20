// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { asSystem, runAsTenant } from "./row-security.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const postgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe.sequential
    : describe.skip;

postgres("organization vault database boundaries", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const org = `vault-org-${suffix}`,
    space = `vault-space-${suffix}`,
    user = `vault-user-${suffix}`;
  const binding = `vault-binding-${suffix}`;
  const actor = { userId: user, spaceId: space };
  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;

  beforeAll(async () => {
    owner = createDb(migrationUrl!);
    app = createDb(runtimeUrl!);
    const db = asSystem(owner.prisma);
    await db.organization.create({
      data: { id: org, name: "Org", slug: org, createdAt: new Date() },
    });
    await db.user.create({
      data: { id: user, name: "User", email: `${user}@test.invalid`, emailVerified: true },
    });
    await db.space.create({ data: { id: space, organizationId: org, name: "Workspace" } });
    await db.installationIdentity.create({
      data: {
        id: "local",
        issuer: "https://accounts.invalid",
        publicKey: "key",
        privateKeyCipher: "encrypted",
        keyFingerprint: "fingerprint",
        operationId: "operation",
        challenge: "challenge",
        state: "ready",
        serverId: "server",
        centralOrganizationId: "central",
        localOrganizationId: org,
        bindingVersion: 7,
      },
    });
    await db.centralWorkspaceBinding.create({
      data: {
        id: binding,
        serverId: "server",
        centralOrganizationId: "central",
        localOrganizationId: org,
        spaceId: space,
        operationId: binding,
        bindingVersion: 7,
        permissionVersion: 1,
        state: "ready",
        members: [],
        verifiedAt: new Date(),
        validUntil: new Date(Date.now() + 60_000),
        organizationType: "shared",
      },
    });
    await db.centralWorkspaceAccess.create({
      data: {
        workspaceId: binding,
        userId: user,
        centralSubject: user,
        role: "admin",
        membershipVersion: "1",
        active: true,
      },
    });
    await db.vaultCredential.create({
      data: {
        id: `personal-${suffix}`,
        userId: user,
        name: "personal",
        origin: "https://example.test",
        auth: {},
        ciphertext: "encrypted",
      },
    });
    await db.organizationVaultCredential.create({
      data: {
        id: `org-${suffix}`,
        organizationId: org,
        name: "company",
        origin: "https://example.test",
        auth: {},
        ciphertext: "encrypted",
      },
    });
    await db.organizationVaultGrant.create({
      data: { spaceId: space, organizationId: org, bindingVersion: 7 },
    });
    await db.organizationVaultCredentialGrant.create({
      data: {
        credentialId: `org-${suffix}`,
        spaceId: space,
        organizationId: org,
        bindingVersion: 7,
      },
    });
    await db.organizationVaultCredential.create({
      data: {
        id: `private-${suffix}`,
        organizationId: org,
        name: "private",
        origin: "https://example.test",
        auth: {},
        ciphertext: "encrypted",
      },
    });
  });
  afterAll(async () => {
    const db = asSystem(owner.prisma);
    await db.centralWorkspaceAccess.deleteMany({ where: { workspaceId: binding } });
    await db.centralWorkspaceBinding.deleteMany({ where: { id: binding } });
    await db.installationIdentity.deleteMany({ where: { id: "local" } });
    await db.organization.deleteMany({ where: { id: org } });
    await db.user.deleteMany({ where: { id: user } });
    await app.prisma.$disconnect();
    await owner.prisma.$disconnect();
  });
  it("hides personal secrets in shared and unverified organizations, but keeps the Personal exception", async () => {
    const read = () => runAsTenant(actor, () => app.prisma.vaultCredential.findMany());
    expect(await read()).toHaveLength(0);
    await asSystem(owner.prisma).centralWorkspaceBinding.update({
      where: { id: binding },
      data: { organizationType: null },
    });
    expect(await read()).toHaveLength(0);
    await asSystem(owner.prisma).centralWorkspaceBinding.update({
      where: { id: binding },
      data: { organizationType: "personal" },
    });
    expect(await read()).toHaveLength(1);
    await asSystem(owner.prisma).installationIdentity.update({
      where: { id: "local" },
      data: { bindingVersion: 8 },
    });
    expect(await read()).toHaveLength(0);
  });
  it("exposes organization secrets only with a current workspace grant; tenants cannot manage them", async () => {
    await asSystem(owner.prisma).installationIdentity.update({
      where: { id: "local" },
      data: { bindingVersion: 7 },
    });
    await asSystem(owner.prisma).centralWorkspaceBinding.update({
      where: { id: binding },
      data: { organizationType: "shared" },
    });
    expect(
      await runAsTenant(actor, () => app.prisma.organizationVaultCredential.findMany()),
    ).toHaveLength(1);
    expect(
      await runAsTenant(actor, () => app.prisma.organizationVaultCredential.findMany()),
    ).toMatchObject([{ name: "company" }]);
    await expect(
      runAsTenant(actor, () => app.prisma.organizationVaultCredentialGrant.findMany()),
    ).resolves.toEqual([]);
    expect(
      await runAsTenant(actor, () => app.prisma.organizationVaultGrant.findMany()),
    ).toHaveLength(0);
    await expect(
      runAsTenant(actor, () => app.prisma.organizationVaultGrant.deleteMany()),
    ).resolves.toEqual({ count: 0 });
    await expect(
      runAsTenant(actor, () => app.prisma.organizationVaultCredential.deleteMany()),
    ).resolves.toEqual({ count: 0 });
    await asSystem(owner.prisma).organizationVaultGrant.delete({ where: { spaceId: space } });
    expect(
      await runAsTenant(actor, () => app.prisma.organizationVaultCredential.findMany()),
    ).toHaveLength(0);
  });
});
