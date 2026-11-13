// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash, createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import type { WorkspaceProjection } from "@orkbot/contracts";
import { identityAudience, installationRequestMessage } from "@orkbot/contracts";
import { createDb, createSpaceForMember, runAsSystem, runAsTenant } from "@orkbot/db";
import { createLocalJWKSet, SignJWT } from "jose";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "./index.js";
import { InstallationClient } from "./installation-client.js";
import { oidcAccountSubject } from "./oidc.js";
import { WorkspaceAuthority } from "./workspace-authority.js";

const enabled =
  process.env.VERIFY_DATABASE === "1" &&
  Boolean(process.env.COPY_TEST_DATABASE) &&
  Boolean(process.env.DATABASE_URL);
const database = enabled
  ? createDb(process.env.DATABASE_URL!, { encryptContent: false, poolMax: 12 })
  : undefined;
const prisma = database?.prisma;
const issuer = "https://accounts.example.test";
const serverId = "30000000-0000-4000-8000-000000000001";
const organizationId = "40000000-0000-4000-8000-000000000001";
const workspaceId = "50000000-0000-4000-8000-000000000001";
const admission = "60000000-0000-4000-8000-000000000001";
const enrollmentId = "70000000-0000-4000-8000-000000000001";
const operationId = "80000000-0000-4000-8000-000000000001";
const system = <T>(run: () => Promise<T>) =>
  runAsSystem("installation identity PostgreSQL test", run);
const signer = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys = createLocalJWKSet({
  keys: [
    {
      ...signer.publicKey.export({ format: "jwk" }),
      kid: "identity-test",
      alg: "RS256",
      use: "sig",
    },
  ],
});

function broker() {
  let publicKey = "";
  let challenge = "";
  let approved = false;
  let failAck = false;
  let failWorkspaceAck = false;
  let wrongNonce = false;
  let members = [
    { userId: "central-participant", role: "member" as const, accessVersion: admission },
  ];
  let permissionVersion = 1;
  let state: "provisioning" | "ready" = "provisioning";
  let mapping: { localOrganizationId: string | null; localWorkspaceId: string | null } = {
    localOrganizationId: null,
    localWorkspaceId: null,
  };
  const fingerprint = () =>
    createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
  const sign = async (payload: Record<string, unknown>) =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: "identity-test" })
      .sign(signer.privateKey);
  const request: typeof fetch = async (url, init) => {
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body));
    const now = Math.floor(Date.now() / 1000);
    if (path.endsWith("/enrollments/start")) {
      const key = createPublicKey({
        key: Buffer.from(body.publicKey, "base64url"),
        type: "spki",
        format: "der",
      });
      expect(
        verify(
          "sha256",
          Buffer.from(
            JSON.stringify([
              "ork-server-enrollment-request-v2",
              body.operationId,
              body.name,
              body.publicKey,
              body.challenge,
              body.timestamp,
              body.nonce,
            ]),
          ),
          key,
          Buffer.from(body.signature, "base64url"),
        ),
      ).toBe(true);
      publicKey = body.publicKey;
      challenge = body.challenge;
      return Response.json({
        version: 2,
        id: enrollmentId,
        code: "ABCDEFGHJK",
        receipt: "r".repeat(43),
        keyFingerprint: fingerprint(),
        expiresAt: now + 900,
      });
    }
    if (path.endsWith("/enrollments/poll")) {
      expect(body).toEqual({ enrollmentId, receipt: "r".repeat(43) });
      if (!approved) return Response.json({ state: "pending" });
      const grant = await sign({
        iss: issuer,
        aud: identityAudience(serverId),
        sub: serverId,
        purpose: "ork-server-enrollment-v2",
        iat: now,
        exp: now + 60,
        jti: randomUUID(),
        enrollment_id: enrollmentId,
        nonce: challenge,
        installation_key: fingerprint(),
        server_id: serverId,
        organization_id: organizationId,
        binding_version: 1,
      });
      return Response.json({ state: "approved", grant });
    }
    const headers = new Headers(init?.headers);
    const proof = {
      serverId: headers.get("x-ork-server-id")!,
      bindingVersion: Number(headers.get("x-ork-binding-version")),
      timestamp: Number(headers.get("x-ork-proof-time")),
      nonce: headers.get("x-ork-proof-nonce")!,
    };
    const message = installationRequestMessage(
      proof,
      "POST",
      path,
      createHash("sha256").update(String(init?.body)).digest("hex"),
    );
    expect(
      verify(
        "sha256",
        Buffer.from(message),
        createPublicKey({ key: Buffer.from(publicKey, "base64url"), type: "spki", format: "der" }),
        Buffer.from(headers.get("x-ork-proof-signature")!, "base64url"),
      ),
    ).toBe(true);
    if (path.endsWith("/enrollments/acknowledge"))
      return Response.json({ state: "ready", serverId }, { status: failAck ? 503 : 200 });
    if (path.endsWith("/workspaces/acknowledge")) {
      mapping = {
        localOrganizationId: body.localOrganizationId,
        localWorkspaceId: body.localWorkspaceId,
      };
      state = "ready";
      return Response.json(
        { workspace: { id: workspaceId, state } },
        { status: failWorkspaceAck ? 503 : 200 },
      );
    }
    if (path.endsWith("/servers/synchronize")) {
      const projection: WorkspaceProjection = {
        serverId,
        organizationId,
        bindingVersion: 1,
        keyFingerprint: fingerprint(),
        verifiedAt: now,
        expiresAt: now + 300,
        workspaces: [
          {
            id: workspaceId,
            name: "Workspace",
            operationId,
            state,
            ...mapping,
            permissionVersion,
            members,
          },
        ],
      };
      return Response.json({
        grant: await sign({
          iss: issuer,
          aud: identityAudience(serverId),
          sub: serverId,
          purpose: "ork-workspace-projection-v2",
          nonce: wrongNonce ? "wrong" : proof.nonce,
          jti: randomUUID(),
          iat: now,
          exp: now + 300,
          ...projection,
        }),
      });
    }
    if (path.endsWith("/servers/routes")) return Response.json({ ok: true });
    throw new Error("Unexpected installation endpoint");
  };
  return {
    request,
    loginGrant: async (
      challenge: string,
      email = "participant@example.test",
      overrides: Record<string, unknown> = {},
    ) => {
      const now = Math.floor(Date.now() / 1000);
      return sign({
        iss: issuer,
        aud: identityAudience(serverId),
        sub: "central-participant",
        purpose: "ork-server-login-v2",
        jti: randomUUID(),
        iat: now,
        exp: now + 60,
        nonce: challenge,
        server_id: serverId,
        organization_id: organizationId,
        workspace_id: workspaceId,
        binding_version: 1,
        installation_key: fingerprint(),
        permission_version: permissionVersion,
        workspace_role: "member",
        membership_version: members[0]?.accessVersion ?? admission,
        email,
        email_verified: true,
        name: "Participant",
        ...overrides,
      });
    },
    approve: () => {
      approved = true;
    },
    failAcknowledgement: (value: boolean) => {
      failAck = value;
    },
    wrongNonce: () => {
      wrongNonce = true;
    },
    failWorkspaceAck: (value: boolean) => {
      failWorkspaceAck = value;
    },
    revoke: () => {
      members = [];
      permissionVersion++;
    },
    readd: () => {
      members = [{ userId: "central-participant", role: "member", accessVersion: randomUUID() }];
      permissionVersion++;
    },
  };
}

describe.skipIf(!enabled)(
  "installation identity and workspace admission on restricted PostgreSQL",
  () => {
    let server: ReturnType<typeof broker>;
    let installation: InstallationClient;
    let authority: WorkspaceAuthority | undefined;
    beforeEach(async () => {
      authority?.dispose();
      await system(async () => {
        await prisma!.centralSessionBinding.deleteMany();
        await prisma!.centralWorkspaceAccess.deleteMany();
        await prisma!.centralWorkspaceBinding.deleteMany();
        await prisma!.installationIdentity.deleteMany();
        await prisma!.organization.deleteMany({ where: { id: { startsWith: "identity-test-" } } });
        await prisma!.user.deleteMany({ where: { id: "identity-test-user" } });
      });
      server = broker();
      installation = new InstallationClient(prisma!, {
        issuer,
        encryptionKey: "fixture-encryption-material".repeat(3),
        request: server.request,
        keys,
      });
    });
    afterAll(async () => {
      authority?.dispose();
      await database?.pool.end();
    });
    const enroll = async () => {
      await installation.beginEnrollment("Installation", organizationId);
      server.approve();
      await installation.pollEnrollment();
    };
    it("provisions a clean installation once and resumes an acknowledgement lost after commit", async () => {
      await enroll();
      authority = new WorkspaceAuthority(prisma!, installation, issuer);
      await authority.synchronize();
      server.failWorkspaceAck(true);
      let createdOrganization: string | undefined;
      try {
        await expect(authority.provisionWorkspace(workspaceId)).rejects.toThrow();
        const reserved = await system(() =>
          prisma!.centralWorkspaceBinding.findUniqueOrThrow({ where: { id: workspaceId } }),
        );
        createdOrganization = reserved.localOrganizationId;
        expect(reserved.state).toBe("provisioning");
        expect(
          await system(() =>
            prisma!.space.count({ where: { organizationId: createdOrganization } }),
          ),
        ).toBe(1);
        authority.dispose();
        authority = new WorkspaceAuthority(prisma!, installation, issuer);
        await authority.synchronize();
        server.failWorkspaceAck(false);
        await Promise.all([
          authority.provisionWorkspace(workspaceId),
          authority.provisionWorkspace(workspaceId),
        ]);
        await authority.synchronize();
        const confirmed = await system(() =>
          prisma!.centralWorkspaceBinding.findUniqueOrThrow({ where: { id: workspaceId } }),
        );
        expect(confirmed).toMatchObject({
          spaceId: reserved.spaceId,
          localOrganizationId: createdOrganization,
          operationId,
          state: "ready",
        });
        expect(
          await system(() =>
            prisma!.space.count({ where: { organizationId: createdOrganization } }),
          ),
        ).toBe(1);
        expect(
          await system(() => prisma!.spaceMember.count({ where: { spaceId: reserved.spaceId } })),
        ).toBe(0);
      } finally {
        if (createdOrganization)
          await system(async () => {
            await prisma!.centralWorkspaceBinding.deleteMany({
              where: { localOrganizationId: createdOrganization },
            });
            await prisma!.organization.delete({ where: { id: createdOrganization } });
          });
      }
    });

    it("requires explicit mapping when local organizations already contain data", async () => {
      await enroll();
      await system(() =>
        prisma!.organization.createMany({
          data: ["a", "b"].map((suffix) => ({
            id: `identity-test-existing-${suffix}`,
            name: "Organization",
            slug: `identity-test-existing-${suffix}`,
            createdAt: new Date(),
          })),
        }),
      );
      authority = new WorkspaceAuthority(prisma!, installation, issuer);
      await authority.synchronize();
      await expect(authority.provisionWorkspace(workspaceId)).rejects.toThrow(
        "Explicit local organization mapping required",
      );
      expect(await system(() => prisma!.centralWorkspaceBinding.count())).toBe(0);
      expect(
        await system(() =>
          prisma!.organization.count({ where: { id: { startsWith: "identity-test-existing-" } } }),
        ),
      ).toBe(2);
    });

    const provision = async () => {
      await enroll();
      await system(async () => {
        await prisma!.organization.create({
          data: {
            id: "identity-test-org",
            name: "Organization",
            slug: "identity-test-org",
            createdAt: new Date(),
          },
        });
        await prisma!.space.create({
          data: {
            id: "identity-test-space",
            organizationId: "identity-test-org",
            name: "Workspace",
          },
        });
        await prisma!.user.create({
          data: {
            id: "identity-test-user",
            email: "participant@example.test",
            name: "Participant",
            emailVerified: true,
          },
        });
        await prisma!.account.create({
          data: {
            id: randomUUID(),
            userId: "identity-test-user",
            providerId: "oidc",
            accountId: oidcAccountSubject(issuer, "central-participant"),
          },
        });
      });
      authority = new WorkspaceAuthority(prisma!, installation, issuer);
      await authority.synchronize();
      await authority.mapWorkspace(workspaceId, "identity-test-org", "identity-test-space");
      expect(await authority.work("identity-test-space", "identity-test-user")).toBeNull();
      await authority.synchronize();
      await system(async () => {
        await prisma!.session.create({
          data: {
            id: "identity-test-session",
            userId: "identity-test-user",
            token: randomUUID(),
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        });
        await prisma!.centralSessionBinding.create({
          data: {
            sessionId: "identity-test-session",
            workspaceId,
            centralSubject: "central-participant",
            membershipVersion: admission,
          },
        });
      });
    };
    it("keeps one encrypted installation key across concurrent initialization and restart", async () => {
      await Promise.all(Array.from({ length: 12 }, () => installation.ensureIdentity()));
      const row = await system(() =>
        prisma!.installationIdentity.findUniqueOrThrow({ where: { id: "local" } }),
      );
      expect(row.privateKeyCipher).not.toContain(row.publicKey);
      await installation.ensureIdentity();
      expect(await system(() => prisma!.installationIdentity.count())).toBe(1);
      const wrong = new InstallationClient(prisma!, {
        issuer,
        encryptionKey: "different-fixture-material".repeat(3),
        request: server.request,
        keys,
      });
      await expect(wrong.ensureIdentity()).rejects.toThrow("could not be opened");
      expect(
        (
          await system(() =>
            prisma!.installationIdentity.findUniqueOrThrow({ where: { id: "local" } }),
          )
        ).keyFingerprint,
      ).toBe(row.keyFingerprint);
    });
    it("persists binding before acknowledgement and resumes without replacing its identity", async () => {
      await installation.beginEnrollment("Installation", organizationId);
      expect(await installation.pollEnrollment()).toBeNull();
      server.approve();
      server.failAcknowledgement(true);
      await expect(installation.pollEnrollment()).rejects.toThrow("503");
      expect(await installation.configuration()).toBeNull();
      expect(
        (
          await system(() =>
            prisma!.installationIdentity.findUniqueOrThrow({ where: { id: "local" } }),
          )
        ).state,
      ).toBe("binding");
      server.failAcknowledgement(false);
      expect(await installation.pollEnrollment()).toMatchObject({
        serverId,
        organizationId,
        bindingVersion: 1,
      });
    });
    it("resumes local setup with the same key and operation after approval or acknowledgement is lost", async () => {
      const pending = await installation.resumeEnrollment("This computer", organizationId);
      expect(pending.state).toBe("approval-required");
      const before = await system(() =>
        prisma!.installationIdentity.findUniqueOrThrow({ where: { id: "local" } }),
      );
      await expect(installation.resumeEnrollment("This computer", workspaceId)).rejects.toThrow(
        "organization selection changed",
      );
      server.approve();
      server.failAcknowledgement(true);
      await expect(installation.resumeEnrollment("This computer", organizationId)).rejects.toThrow(
        "503",
      );
      installation = new InstallationClient(prisma!, {
        issuer,
        encryptionKey: "fixture-encryption-material".repeat(3),
        request: server.request,
        keys,
      });
      server.failAcknowledgement(false);
      const ready = await installation.resumeEnrollment("This computer", organizationId);
      expect(ready).toEqual({
        state: "ready",
        serverId,
        organizationId,
        bindingVersion: 1,
        keyFingerprint: before.keyFingerprint,
      });
      expect(await installation.resumeEnrollment("This computer", organizationId)).toEqual(ready);
      const after = await system(() =>
        prisma!.installationIdentity.findUniqueOrThrow({ where: { id: "local" } }),
      );
      expect(after.operationId).toBe(before.operationId);
      expect(after.publicKey).toBe(before.publicKey);
      expect(after.privateKeyCipher).toBe(before.privateKeyCipher);
    });
    it("publishes only validated origin routes using the durable installation proof", async () => {
      await enroll();
      const configuration = (await installation.configuration())!;
      await expect(
        installation.publishRoutes([], { ...configuration, bindingVersion: 2 }),
      ).rejects.toThrow("Installation binding changed");
      await expect(
        installation.publishRoutes([], { ...configuration, keyFingerprint: "c".repeat(64) }),
      ).rejects.toThrow("Installation binding changed");
      await expect(
        installation.publishRoutes([
          { kind: "direct", address: "https://server.example.test", deviceId: null },
        ]),
      ).resolves.toBeUndefined();
      for (const routes of [
        [{ kind: "direct", address: "https://user:secret@server.example.test", deviceId: null }],
        [{ kind: "direct", address: "https://localhost", deviceId: null }],
        [{ kind: "local", address: "http://127.0.0.1:45173", deviceId: null }],
        [
          {
            kind: "direct",
            address: "https://server.example.test",
            deviceId: null,
            token: "must-not-be-sent",
          },
        ],
      ])
        await expect(installation.publishRoutes(routes)).rejects.toThrow();
    });
    it("signs the exact serialized bytes once for requests with a stateful serializer", async () => {
      await enroll();
      let serializations = 0;
      await installation.signedRequest("/servers/routes", {
        toJSON() {
          return { revision: ++serializations };
        },
      });
      expect(serializations).toBe(1);
    });
    it("rejects an otherwise valid projection with a different request nonce", async () => {
      await enroll();
      server.wrongNonce();
      authority = new WorkspaceAuthority(prisma!, installation, issuer);
      await expect(authority.synchronize()).rejects.toThrow("unavailable");
      expect(authority.window.workspace(workspaceId)).toBeNull();
    });
    it("requires exact workspace and admission, blocks revoked rows, and retains local membership settings", async () => {
      await provision();
      expect(
        await authority!.session("identity-test-session", "identity-test-user", "another-space"),
      ).toBeNull();
      await system(() =>
        prisma!.member.update({
          where: {
            organizationId_userId: {
              organizationId: "identity-test-org",
              userId: "identity-test-user",
            },
          },
          data: { role: "owner" },
        }),
      );
      await authority!.synchronize();
      expect(
        await system(() =>
          prisma!.member.findUniqueOrThrow({
            where: {
              organizationId_userId: {
                organizationId: "identity-test-org",
                userId: "identity-test-user",
              },
            },
            select: { role: true },
          }),
        ),
      ).toEqual({ role: "member" });
      expect(await authority!.session("identity-test-session", "identity-test-user")).toMatchObject(
        { spaceId: "identity-test-space" },
      );
      const bot = await system(() =>
        prisma!.bot.create({
          data: {
            userId: "identity-test-user",
            spaceId: "identity-test-space",
            name: "Test",
            color: "blue",
          },
        }),
      );
      const running = await authority!.work("identity-test-space", "identity-test-user", admission);
      expect(running).not.toBeNull();
      const queued = await system(async () => {
        const thread = await prisma!.thread.create({
          data: { spaceId: bot.spaceId, botId: bot.id, userId: bot.userId },
        });
        const task = await prisma!.task.create({
          data: {
            spaceId: bot.spaceId,
            botId: bot.id,
            userId: bot.userId,
            threadId: thread.id,
            prompt: "Fixture",
            status: "queued",
          },
        });
        return prisma!.run.create({
          data: {
            spaceId: bot.spaceId,
            botId: bot.id,
            userId: bot.userId,
            threadId: thread.id,
            taskId: task.id,
            trigger: "user",
            status: "queued",
          },
        });
      });
      expect(queued).toMatchObject({
        centralWorkspaceId: workspaceId,
        workspaceMembershipVersion: admission,
        requiredReaderVersion: 4,
      });
      const oldReader = await system(() =>
        prisma!.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.run_reader_version', '3', true)`;
          return tx.run.updateMany({
            where: { id: queued.id },
            data: { status: "leased", leaseOwner: "old-reader" },
          });
        }),
      );
      expect(oldReader.count).toBe(0);
      await expect(
        system(() =>
          prisma!.run.update({
            where: { id: queued.id },
            data: { workspaceMembershipVersion: randomUUID() },
          }),
        ),
      ).rejects.toThrow("Run admission is immutable");
      expect(
        await runAsTenant({ spaceId: "identity-test-space", userId: "identity-test-user" }, () =>
          prisma!.bot.count({ where: { spaceId: "identity-test-space" } }),
        ),
      ).toBe(1);
      server.revoke();
      await authority!.synchronize();
      expect(running!.signal.aborted).toBe(true);
      expect(await authority!.session("identity-test-session", "identity-test-user")).toBeNull();
      expect(
        await runAsTenant({ spaceId: "identity-test-space", userId: "identity-test-user" }, () =>
          prisma!.bot.count({ where: { spaceId: "identity-test-space" } }),
        ),
      ).toBe(0);
      expect(
        await system(() =>
          prisma!.spaceMember.count({ where: { spaceId: "identity-test-space" } }),
        ),
      ).toBe(1);
      server.readd();
      await authority!.synchronize();
      expect(
        await authority!.execution({
          spaceId: queued.spaceId,
          userId: queued.userId,
          workspaceId: queued.centralWorkspaceId,
          membershipVersion: queued.workspaceMembershipVersion,
        }),
      ).toBeNull();
      expect(await authority!.session("identity-test-session", "identity-test-user")).toBeNull();
      expect(
        await authority!.work("identity-test-space", "identity-test-user", admission),
      ).toBeNull();
      const nextAccess = await system(() =>
        prisma!.centralWorkspaceAccess.findUniqueOrThrow({
          where: { workspaceId_userId: { workspaceId, userId: "identity-test-user" } },
        }),
      );
      const nextWork = await authority!.work(
        "identity-test-space",
        "identity-test-user",
        nextAccess.membershipVersion,
      );
      expect(nextWork).not.toBeNull();
      nextWork!.dispose();
    });
    it("logs in through Better Auth with an exact workspace, rejects replay and does not provision another personal space", async () => {
      await provision();
      const auth = createAuth(prisma!, {
        secret: "fixture-auth-material".repeat(3),
        baseURL: "https://installation.example.test",
        webOrigin: "https://installation.example.test",
        nativeAccounts: { issuer },
        passwordAuth: false,
        signupsEnabled: "false",
        signupAllowlist: "",
        workspaceAuthority: authority!,
        singleAccount: true,
        singleAccountOwnerKey: oidcAccountSubject(issuer, "local-installer-owner"),
      });
      const call = (path: string, body: object) =>
        system(() =>
          auth.handler(
            new Request(`https://installation.example.test/api/auth/native/workspace/${path}`, {
              method: "POST",
              headers: {
                origin: "https://installation.example.test",
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            }),
          ),
        );
      try {
        const challengeResponse = await call("challenge", {});
        expect(challengeResponse.status).toBe(200);
        const { challenge } = (await challengeResponse.json()) as { challenge: string };
        const invalid = [
          { nonce: "other-challenge" },
          { aud: identityAudience(randomUUID()) },
          { installation_key: "b".repeat(64) },
          { workspace_id: randomUUID() },
          { membership_version: randomUUID() },
          { binding_version: 2 },
          { workspace_role: "admin" },
          { purpose: "ork-workspace-access-v2" },
          { exp: Math.floor(Date.now() / 1000) - 1 },
          { email_verified: false },
        ];
        for (const overrides of invalid)
          expect(
            (
              await call("complete", {
                challenge,
                grant: await server.loginGrant(challenge, undefined, overrides),
              })
            ).status,
          ).toBe(403);
        const grant = await server.loginGrant(challenge);
        const complete = await call("complete", { challenge, grant });
        expect(complete.status).toBe(200);
        const result = (await complete.json()) as { token: string };
        expect(result).toMatchObject({
          workspaceId,
          spaceId: "identity-test-space",
          user: { id: "identity-test-user" },
        });
        const session = await system(() =>
          prisma!.session.findUniqueOrThrow({ where: { token: result.token.split(".")[0]! } }),
        );
        expect(await authority!.session(session.id, "identity-test-user")).toMatchObject({
          workspaceId,
        });
        expect((await call("complete", { challenge, grant })).status).toBe(403);
        expect(
          await system(() =>
            prisma!.space.count({ where: { organizationId: "identity-test-org" } }),
          ),
        ).toBe(1);
        expect(
          await system(() =>
            prisma!.organization.count({
              where: { members: { some: { userId: "identity-test-user" } } },
            }),
          ),
        ).toBe(1);
        const token = await system(() =>
          auth.issueAccountExportToken("identity-test-user", {
            sessionId: session.id,
            spaceId: "identity-test-space",
          }),
        );
        expect(await system(() => auth.consumeAccountExportToken(token))).toBeNull();
        const exportScope = await system(() => auth.consumeWorkspaceExportToken(token));
        expect(exportScope).toMatchObject({
          workspaceId,
          spaceId: "identity-test-space",
          revision: admission,
        });
        exportScope!.dispose();
        expect(await system(() => auth.consumeWorkspaceExportToken(token))).toBeNull();
        await expect(
          system(() =>
            auth.issueAccountExportToken("identity-test-user", {
              sessionId: session.id,
              spaceId: "another-space",
            }),
          ),
        ).rejects.toThrow();
        const revokedToken = await system(() =>
          auth.issueAccountExportToken("identity-test-user", {
            sessionId: session.id,
            spaceId: "identity-test-space",
          }),
        );
        server.revoke();
        await authority!.synchronize();
        expect(await system(() => auth.consumeWorkspaceExportToken(revokedToken))).toBeNull();
      } finally {
        auth.disposeOidcDiscovery();
      }
    });

    it("provisions a new central subject without email auto-linking or an additional local workspace", async () => {
      await provision();
      await system(async () => {
        await prisma!.centralSessionBinding.deleteMany();
        await prisma!.session.deleteMany({ where: { userId: "identity-test-user" } });
        await prisma!.account.deleteMany({ where: { userId: "identity-test-user" } });
        await prisma!.centralWorkspaceAccess.deleteMany();
        await prisma!.spaceMember.deleteMany({ where: { userId: "identity-test-user" } });
        await prisma!.member.deleteMany({ where: { userId: "identity-test-user" } });
        await prisma!.user.delete({ where: { id: "identity-test-user" } });
      });
      const auth = createAuth(prisma!, {
        secret: "fixture-auth-material".repeat(3),
        baseURL: "https://installation.example.test",
        webOrigin: "https://installation.example.test",
        nativeAccounts: { issuer },
        passwordAuth: false,
        signupsEnabled: "false",
        signupAllowlist: "",
        workspaceAuthority: authority!,
        singleAccount: true,
        singleAccountOwnerKey: oidcAccountSubject(issuer, "local-installer-owner"),
      });
      const call = (path: string, body: object) =>
        system(() =>
          auth.handler(
            new Request(`https://installation.example.test/api/auth/native/workspace/${path}`, {
              method: "POST",
              headers: {
                origin: "https://installation.example.test",
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            }),
          ),
        );
      try {
        const { challenge } = (await (await call("challenge", {})).json()) as { challenge: string };
        const response = await call("complete", {
          challenge,
          grant: await server.loginGrant(challenge, "new-participant@example.test"),
        });
        expect(response.status).toBe(200);
        const { user } = (await response.json()) as { user: { id: string } };
        expect(
          await system(() =>
            prisma!.space.count({ where: { memberships: { some: { userId: user.id } } } }),
          ),
        ).toBe(1);
        expect(
          await system(() =>
            prisma!.member.findFirst({ where: { userId: user.id }, select: { role: true } }),
          ),
        ).toEqual({ role: "member" });
        await system(() => prisma!.account.deleteMany({ where: { userId: user.id } }));
        const next = (await (await call("challenge", {})).json()) as { challenge: string };
        expect(
          (
            await call("complete", {
              challenge: next.challenge,
              grant: await server.loginGrant(next.challenge, "new-participant@example.test"),
            })
          ).status,
        ).toBe(403);
        await system(() => prisma!.user.delete({ where: { id: user.id } }));
      } finally {
        auth.disposeOidcDiscovery();
      }
    });

    it("keeps legacy account-wide tools outside a managed workspace", async () => {
      await provision();
      await system(async () => {
        await prisma!.space.create({
          data: {
            id: "identity-test-other-space",
            organizationId: "identity-test-org",
            name: "Other workspace",
          },
        });
        await prisma!.mcpServer.create({
          data: {
            id: "identity-test-external-tool",
            spaceId: "identity-test-other-space",
            userId: "identity-test-user",
            slug: "private-tool",
            name: "Private tool",
            transport: "http",
            endpoint: "https://tools.example.test",
            allSpaces: true,
          },
        });
      });
      expect(
        await runAsTenant({ spaceId: "identity-test-space", userId: "identity-test-user" }, () =>
          prisma!.mcpServer.count(),
        ),
      ).toBe(0);
    });

    it("refuses local sibling workspaces in a centrally mapped organization", async () => {
      await provision();
      await expect(
        system(() =>
          createSpaceForMember(prisma!, {
            currentSpaceId: "identity-test-space",
            userId: "identity-test-user",
            name: "Unregistered sibling",
          }),
        ),
      ).rejects.toThrow("Create workspaces in Accounts");
      expect(
        await system(() => prisma!.space.count({ where: { organizationId: "identity-test-org" } })),
      ).toBe(1);
    });

    it("requires fresh central verification after restart despite a valid database projection", async () => {
      await provision();
      authority!.dispose();
      authority = new WorkspaceAuthority(prisma!, installation, issuer);
      expect(await authority.session("identity-test-session", "identity-test-user")).toBeNull();
      expect(await authority.work("identity-test-space", "identity-test-user")).toBeNull();
      await authority.synchronize();
      expect(await authority.session("identity-test-session", "identity-test-user")).not.toBeNull();
    });
  },
);
