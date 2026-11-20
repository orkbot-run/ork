// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { asSystem, createDb, itemSecretSpace, runAsSystem, runAsTenant } from "@orkbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadBotCommandEnvironment, revealBotSecret, storeBotSecret } from "./bot-secrets.js";
import { McpOAuthBroker } from "./mcp-oauth.js";
import { OrganizationVault } from "./organization-vault.js";
import { withSecretPersistence } from "./secret-persistence.js";
import { EncryptedSecretStore } from "./secrets.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const postgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe.sequential
    : describe.skip;

postgres("organization vault on the installation", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const org = `vault-org-${suffix}`,
    otherOrg = `other-vault-org-${suffix}`,
    space = `vault-space-${suffix}`,
    space2 = `vault-space-2-${suffix}`,
    adminId = `admin-${suffix}`,
    memberId = `member-${suffix}`,
    binding = `binding-${suffix}`,
    binding2 = `binding-2-${suffix}`;
  const admin = { userId: adminId, spaceId: space, membershipVersion: "admin-v1" };
  const member = { userId: memberId, spaceId: space, membershipVersion: "member-v1" };
  const secrets = new EncryptedSecretStore("only-a-test-key");
  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;
  let vault: OrganizationVault;

  beforeAll(async () => {
    owner = createDb(migrationUrl!);
    app = createDb(runtimeUrl!);
    const db = asSystem(owner.prisma);
    await db.organization.create({
      data: { id: org, name: "Org", slug: org, createdAt: new Date() },
    });
    await db.organization.create({
      data: { id: otherOrg, name: "Other org", slug: otherOrg, createdAt: new Date() },
    });
    for (const id of [adminId, memberId])
      await db.user.create({
        data: { id, name: id, email: `${id}@test.invalid`, emailVerified: true },
      });
    await db.space.create({ data: { id: space, organizationId: org, name: "Workspace" } });
    await db.space.create({ data: { id: space2, organizationId: org, name: "Other workspace" } });
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
        members: [
          { userId: "central-admin", accessVersion: "admin-v1", organizationRole: "admin" },
          { userId: "central-member", accessVersion: "member-v1", organizationRole: "member" },
        ],
        verifiedAt: new Date(),
        validUntil: new Date(Date.now() + 60_000),
        organizationType: "shared",
      },
    });
    await db.centralWorkspaceBinding.create({
      data: {
        id: binding2,
        serverId: "server",
        centralOrganizationId: "central",
        localOrganizationId: org,
        spaceId: space2,
        operationId: binding2,
        bindingVersion: 7,
        permissionVersion: 1,
        state: "ready",
        members: [
          { userId: "central-member", accessVersion: "member-v1", organizationRole: "member" },
        ],
        verifiedAt: new Date(),
        validUntil: new Date(Date.now() + 60_000),
        organizationType: "shared",
      },
    });
    await db.centralWorkspaceAccess.create({
      data: {
        workspaceId: binding2,
        userId: memberId,
        centralSubject: "central-member",
        role: "member",
        membershipVersion: "member-v1",
        active: true,
      },
    });
    for (const [userId, centralSubject, membershipVersion] of [
      [adminId, "central-admin", "admin-v1"],
      [memberId, "central-member", "member-v1"],
    ])
      await db.centralWorkspaceAccess.create({
        data: {
          workspaceId: binding,
          userId: userId!,
          centralSubject: centralSubject!,
          role: "admin",
          membershipVersion: membershipVersion!,
          active: true,
        },
      });
    vault = new OrganizationVault(withSecretPersistence(app.prisma, secrets), secrets);
  });
  afterAll(async () => {
    const db = asSystem(owner.prisma);
    await db.centralWorkspaceAccess.deleteMany({
      where: { workspaceId: { in: [binding, binding2] } },
    });
    await db.centralWorkspaceBinding.deleteMany({ where: { id: { in: [binding, binding2] } } });
    await db.installationIdentity.deleteMany({ where: { id: "local" } });
    await db.organization.deleteMany({ where: { id: { in: [org, otherOrg] } } });
    await db.user.deleteMany({ where: { id: { in: [adminId, memberId] } } });
    await app.prisma.$disconnect();
    await owner.prisma.$disconnect();
  });

  it("starts OAuth for an integration marked available in all spaces without crossing workspace boundaries", async () => {
    const server = await asSystem(owner.prisma).mcpServer.create({
      data: {
        spaceId: space,
        userId: adminId,
        slug: "oauth-test",
        name: "OAuth test",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
        allSpaces: true,
      },
    });
    const network = {
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        const host = request.headers.get("host");
        if (host) url.host = host;
        if (url.href === "https://mcp.example.test/mcp" && request.method === "POST")
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate":
                'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
            },
          });
        if (url.href === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp")
          return Response.json({
            resource: "https://mcp.example.test/mcp",
            authorization_servers: ["https://auth.example.test"],
          });
        if (url.href === "https://auth.example.test/.well-known/oauth-authorization-server")
          return Response.json({
            issuer: "https://auth.example.test",
            authorization_endpoint: "https://auth.example.test/authorize",
            token_endpoint: "https://auth.example.test/token",
            registration_endpoint: "https://auth.example.test/register",
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          });
        if (url.href === "https://auth.example.test/register")
          return Response.json({
            client_id: "test-client",
            redirect_uris: ["https://example.test/mcp/oauth/callback"],
            token_endpoint_auth_method: "none",
          });
        throw new Error(`Unexpected OAuth request: ${url.href}`);
      },
    };
    const broker = new McpOAuthBroker(withSecretPersistence(app.prisma, secrets), secrets, network);
    const result = await runAsTenant(admin, () =>
      broker.begin({
        ...admin,
        serverId: server.id,
        redirectUri: "https://example.test/mcp/oauth/callback",
      }),
    );
    expect(result.status).toBe("authorization_required");
    const stored = await asSystem(owner.prisma).mcpServer.findUniqueOrThrow({
      where: { id: server.id },
      include: { secret: true },
    });
    expect(stored.secret?.spaceId).toBe(space);
    await expect(
      runAsTenant({ userId: memberId, spaceId: space2 }, () =>
        app.prisma.secret.findMany({ where: { id: stored.secretId! } }),
      ),
    ).resolves.toEqual([]);
  });

  it("does not promote workspace secrets to account scope without a tenant context", async () => {
    const result = await runAsSystem("background secret scope test", () =>
      app.prisma.$transaction((tx) => itemSecretSpace(tx, space, true)),
    );
    expect(result).toBe(space);
  });

  it("retains account sharing for an unmanaged workspace in a system job", async () => {
    const unmanaged = `unmanaged-${suffix}`;
    await asSystem(owner.prisma).space.create({
      data: { id: unmanaged, organizationId: org, name: "Unmanaged" },
    });
    const result = await runAsSystem("background secret scope test", () =>
      app.prisma.$transaction((tx) => itemSecretSpace(tx, unmanaged, true)),
    );
    expect(result).toBeNull();
  });

  it("requires organization administration, stores encrypted, and respects workspace grants", async () => {
    const item = {
      destination: { name: "company-key", origin: "", auth: { type: "command" as const } },
      plaintext: "test-private-value",
      createOnly: true,
    };
    await expect(vault.put(member, item)).rejects.toThrow("Organization vault access denied");
    await vault.put(admin, item);
    await expect(vault.put(admin, item)).rejects.toThrow("already exists");
    const stored = await asSystem(owner.prisma).organizationVaultCredential.findFirstOrThrow({
      where: { organizationId: org },
    });
    expect(stored.ciphertext).not.toContain(item.plaintext);
    const list = await vault.list(admin);
    expect(JSON.stringify(list)).not.toContain(item.plaintext);
    expect(JSON.stringify(list)).not.toContain(stored.ciphertext);
    await expect(vault.reveal(member, item.destination.name)).rejects.toThrow(
      "Organization vault access denied",
    );
    expect(await vault.reveal(admin, item.destination.name)).toEqual({ value: item.plaintext });
    const originalLoad = secrets.load.bind(secrets);
    const interrupt = vi
      .spyOn(secrets, "load")
      .mockImplementationOnce(async (ciphertext, context) => {
        await asSystem(owner.prisma).centralWorkspaceBinding.update({
          where: { id: binding },
          data: {
            members: [
              { userId: "central-member", accessVersion: "member-v1", organizationRole: "member" },
            ],
          },
        });
        return originalLoad(ciphertext, context);
      });
    await expect(vault.reveal(admin, item.destination.name)).rejects.toThrow(
      "Organization vault access denied",
    );
    interrupt.mockRestore();
    await asSystem(owner.prisma).centralWorkspaceBinding.update({
      where: { id: binding },
      data: {
        members: [
          { userId: "central-admin", accessVersion: "admin-v1", organizationRole: "admin" },
          { userId: "central-member", accessVersion: "member-v1", organizationRole: "member" },
        ],
      },
    });
    await expect(vault.setWorkspaceAccess(member, space, true)).rejects.toThrow(
      "Organization vault access denied",
    );
    const scope = { userId: memberId, spaceId: space };
    const foreign = await secrets.put(
      "other-company-value",
      {
        ...scope,
        operationId: "foreign",
        traceId: "foreign",
        signal: new AbortController().signal,
      },
      { recordId: "foreign-secret" },
    );
    await asSystem(owner.prisma).organizationVaultCredential.create({
      data: {
        id: "foreign-secret",
        organizationId: otherOrg,
        name: "foreign-key",
        origin: "",
        auth: { type: "command" },
        ciphertext: foreign.ciphertext,
      },
    });
    const personal = await secrets.put(
      "personal-private-value",
      {
        ...scope,
        operationId: "personal",
        traceId: "personal",
        signal: new AbortController().signal,
      },
      { recordId: "personal-secret" },
    );
    await asSystem(owner.prisma).vaultCredential.create({
      data: {
        id: "personal-secret",
        userId: memberId,
        name: "personal-key",
        origin: "",
        auth: { type: "command" },
        ciphertext: personal.ciphertext,
      },
    });
    await expect(
      runAsTenant(scope, () =>
        storeBotSecret({
          prisma: app.prisma,
          secretStore: secrets,
          scope,
          destination: item.destination,
          plaintext: "private",
        }),
      ),
    ).rejects.toThrow("Only organization administrators");
    await expect(
      runAsTenant(scope, () =>
        storeBotSecret({
          prisma: owner.prisma,
          secretStore: secrets,
          scope,
          destination: item.destination,
          plaintext: "private",
        }),
      ),
    ).rejects.toThrow("Only organization administrators");
    const load = () =>
      runAsTenant(scope, () => loadBotCommandEnvironment(app.prisma, secrets, scope));
    // Owner connections bypass PostgreSQL RLS, so the application must still enforce both rules.
    const loadAsOwner = () =>
      runAsTenant(scope, () => loadBotCommandEnvironment(owner.prisma, secrets, scope));
    await expect(
      runAsTenant(scope, () =>
        revealBotSecret({
          prisma: owner.prisma,
          secretStore: secrets,
          scope,
          name: "personal-key",
        }),
      ),
    ).rejects.toThrow("Only organization administrators");
    const other = { userId: memberId, spaceId: space2 };
    const loadOther = () =>
      runAsTenant(other, () => loadBotCommandEnvironment(app.prisma, secrets, other));
    expect(await load()).toEqual({});
    expect(await loadAsOwner()).toEqual({});
    await asSystem(owner.prisma).centralWorkspaceBinding.update({
      where: { id: binding },
      data: { organizationType: "personal" },
    });
    expect(await load()).toEqual({ PERSONAL_KEY: "personal-private-value" });
    expect(await loadAsOwner()).toEqual({ PERSONAL_KEY: "personal-private-value" });
    await asSystem(owner.prisma).centralWorkspaceBinding.update({
      where: { id: binding },
      data: { organizationType: "shared" },
    });
    await vault.setWorkspaceAccess(admin, space, true);
    expect(await load()).toEqual({ COMPANY_KEY: item.plaintext });
    expect(await loadAsOwner()).toEqual({ COMPANY_KEY: item.plaintext });
    expect(await loadOther()).toEqual({});
    await vault.setWorkspaceAccess(admin, space2, true);
    expect(await loadOther()).toEqual({ COMPANY_KEY: item.plaintext });
    await asSystem(owner.prisma).centralWorkspaceBinding.update({
      where: { id: binding },
      data: { state: "archived" },
    });
    await expect(load()).rejects.toThrow("Workspace access denied");
    await expect(loadAsOwner()).rejects.toThrow("Workspace access denied");
    await asSystem(owner.prisma).centralWorkspaceBinding.update({
      where: { id: binding },
      data: { state: "ready" },
    });
    expect(await load()).toEqual({ COMPANY_KEY: item.plaintext });
    await vault.setWorkspaceAccess(admin, space, false);
    expect(await load()).toEqual({});
    expect(await loadAsOwner()).toEqual({});
    expect(await loadOther()).toEqual({ COMPANY_KEY: item.plaintext });
    await asSystem(owner.prisma).user.delete({ where: { id: adminId } });
    expect(
      await asSystem(owner.prisma).organizationVaultCredential.count({
        where: { organizationId: org },
      }),
    ).toBe(1);
    await asSystem(owner.prisma).centralWorkspaceAccess.deleteMany({
      where: { workspaceId: binding },
    });
    await asSystem(owner.prisma).centralWorkspaceBinding.delete({ where: { id: binding } });
    await asSystem(owner.prisma).space.delete({ where: { id: space } });
    expect(
      await asSystem(owner.prisma).organizationVaultCredential.count({
        where: { organizationId: org },
      }),
    ).toBe(1);
  });
});
