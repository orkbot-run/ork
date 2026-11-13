// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  X509Certificate,
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkspaceProjection } from "@orkbot/contracts";
import {
  INSTALLATION_TRANSPORT_LEASE_PURPOSE,
  identityAudience,
  installationRequestMessage,
  personalActivationMessage,
  personalOfflineMessage,
  personalServerMessage,
  RELAY_SERVER_PURPOSE,
} from "@orkbot/contracts";
import { createDb, createSpaceForMember, runAsSystem, runAsTenant } from "@orkbot/db";
import { createLocalJWKSet, SignJWT } from "jose";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "./index.js";
import { InstallationClient } from "./installation-client.js";
import { InstallationTransportOwner } from "./installation-transport-owner.js";
import { oidcAccountSubject } from "./oidc.js";
import { FilePersonalRevocations } from "./personal-revocations.js";
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
  let bindingVersion = 1;
  const personalDevices = new Set<string>();
  let personalDeviceVersion = 0;
  let synchronizeStatus = 200;
  let transportClaims: Record<string, unknown> = {};
  let relayClaims: Record<string, unknown> = {};
  let relayEnabled = true;
  let calls = 0;
  let timeOffset = 0;
  let state: "provisioning" | "ready" | "disabled" = "provisioning";
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
    calls++;
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body));
    const now = Math.floor(Date.now() / 1000) + timeOffset;
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
        binding_version: bindingVersion,
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
    if (path.endsWith("/servers/transport-lease")) {
      const base = {
        iss: issuer,
        sub: serverId,
        iat: now,
        exp: now + 45,
        server_id: serverId,
        organization_id: organizationId,
        binding_version: bindingVersion,
        installation_key: fingerprint(),
        lease_id: body.ownerId,
      };
      const expiresAt = now + 45;
      return Response.json({
        grant: await sign({
          ...base,
          aud: identityAudience(serverId),
          purpose: INSTALLATION_TRANSPORT_LEASE_PURPOSE,
          nonce: proof.nonce,
          jti: randomUUID(),
          ...transportClaims,
        }),
        expiresAt,
        ...(relayEnabled
          ? {
              relayOrigin: "https://relay.example.test",
              relayTicket: await sign({
                ...base,
                aud: "https://relay.example.test",
                purpose: RELAY_SERVER_PURPOSE,
                jti: randomUUID(),
                ...relayClaims,
              }),
            }
          : {}),
      });
    }
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
      if (synchronizeStatus !== 200)
        return Response.json({ error: "fixture refusal" }, { status: synchronizeStatus });
      const projection: WorkspaceProjection = {
        serverId,
        organizationId,
        bindingVersion,
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
            personalDeviceVersion,
            personalDevices: [...personalDevices],
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
      const personal = overrides.personal_device as { id?: string } | undefined;
      if (
        overrides.organization_type === "personal" &&
        personal?.id &&
        !personalDevices.has(personal.id)
      ) {
        personalDevices.add(personal.id);
        personalDeviceVersion++;
      }
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
        binding_version: bindingVersion,
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
    calls: () => calls,
    timeOffset: (value: number) => {
      timeOffset = value;
    },
    refuseSynchronization: (status: number) => {
      synchronizeStatus = status;
    },
    prepareReconnect: () => {
      synchronizeStatus = 401;
      approved = false;
      bindingVersion++;
      permissionVersion++;
      members = [];
      state = "disabled";
    },
    restoreWorkspace: () => {
      state = "provisioning";
    },
    bindingVersion: (value: number) => {
      bindingVersion = value;
    },
    revokeDevice: (id: string) => {
      personalDevices.delete(id);
      personalDeviceVersion++;
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
    transportClaims: (value: Record<string, unknown>) => {
      transportClaims = value;
    },
    relayClaims: (value: Record<string, unknown>) => {
      relayClaims = value;
    },
    relayEnabled: (value: boolean) => {
      relayEnabled = value;
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
    let revokedDevices = new Set<string>();
    let restorationBarriers = new Set<string>();
    const revocations = {
      refuseInstallation: async () => {
        restorationBarriers.add(randomUUID());
      },
      revoked: async (id: string) => revokedDevices.has(id),
      revoke: async (ids: string[]) => {
        for (const id of ids) revokedDevices.add(id);
      },
      restorationCheckpoint: async () => [...restorationBarriers],
      confirmRestoration: async (checkpoint: readonly string[]) => {
        for (const marker of checkpoint) restorationBarriers.delete(marker);
      },
    };
    let installation: InstallationClient;
    let authority: WorkspaceAuthority | undefined;
    beforeEach(async () => {
      authority?.dispose();
      revokedDevices = new Set();
      restorationBarriers = new Set();
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
    it("elects one transport process and fences takeover and stale cleanup on PostgreSQL", async () => {
      await enroll();
      const first = new InstallationTransportOwner(prisma!);
      const second = new InstallationTransportOwner(prisma!);
      const results = await Promise.all([first.acquire(), second.acquire()]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results[0] ? first : second;
      const loser = winner === first ? second : first;
      const selected = results.find(Boolean)!;
      expect(selected.deadline - performance.now()).toBeGreaterThan(45_000);
      expect(selected.deadline - performance.now()).toBeLessThanOrEqual(60_000);
      expect(await winner.active(selected.configuration)).toBe(true);
      expect(await loser.active(selected.configuration)).toBe(false);
      await loser.release();
      expect(await winner.active(selected.configuration)).toBe(true);
      expect(await winner.active({ ...selected.configuration, bindingVersion: 2 })).toBe(false);
      await system(() =>
        prisma!.installationIdentity.update({
          where: { id: "local" },
          data: { transportLeaseUntil: new Date(Date.now() - 1_000) },
        }),
      );
      expect(await winner.active(selected.configuration)).toBe(false);
      expect(await loser.acquire()).not.toBeNull();
      await winner.release();
      expect(await loser.active(selected.configuration)).toBe(true);
      await loser.release();
      expect(await loser.active(selected.configuration)).toBe(false);
    });

    it("does not elect transport ownership for an unpaired or failed installation", async () => {
      const owner = new InstallationTransportOwner(prisma!);
      await installation.ensureIdentity();
      expect(await owner.acquire()).toBeNull();
      await enroll();
      await system(() =>
        prisma!.installationIdentity.update({ where: { id: "local" }, data: { state: "failed" } }),
      );
      expect(await owner.acquire()).toBeNull();
    });
    it("verifies transport lease and relay authority against the elected owner and exact binding", async () => {
      await enroll();
      const configuration = (await installation.configuration())!;
      const ownerId = randomUUID();
      const lease = await installation.transportLease(ownerId, configuration);
      expect(lease.ownerId).toBe(ownerId);
      expect(lease.deadline).toBeGreaterThan(performance.now());
      expect(lease.deadline - performance.now()).toBeLessThanOrEqual(45_000);
      expect(lease.relay?.origin).toBe("https://relay.example.test");
      expect(lease.relay?.ticket).toBeTruthy();
      server.relayEnabled(false);
      expect((await installation.transportLease(ownerId, configuration)).relay).toBeUndefined();
    });

    it.each([
      { nonce: "different-request" },
      { lease_id: "90000000-0000-4000-8000-000000000001" },
      { binding_version: 2 },
      { installation_key: "0".repeat(64) },
      { purpose: "ork-server-login-v2" },
      { organization_id: "90000000-0000-4000-8000-000000000002" },
    ])("refuses a substituted transport lease (%j)", async (claims) => {
      await enroll();
      server.transportClaims(claims);
      await expect(
        installation.transportLease(randomUUID(), (await installation.configuration())!),
      ).rejects.toThrow();
    });

    it.each([
      { aud: identityAudience(serverId) },
      { purpose: "ork-server-login-v2" },
      { lease_id: "90000000-0000-4000-8000-000000000001" },
      { binding_version: 2 },
      { installation_key: "0".repeat(64) },
    ])("refuses a substituted relay ticket (%j)", async (claims) => {
      await enroll();
      server.relayClaims(claims);
      await expect(
        installation.transportLease(randomUUID(), (await installation.configuration())!),
      ).rejects.toThrow();
    });
    it("provisions a clean installation once and resumes an acknowledgement lost after commit", async () => {
      await enroll();
      authority = new WorkspaceAuthority(prisma!, installation, issuer, undefined, revocations);
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
        authority = new WorkspaceAuthority(prisma!, installation, issuer, undefined, revocations);
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

    it("opens transport only after pairing and keeps the enrolled key across certificate renewal", async () => {
      await installation.ensureIdentity();
      await expect(installation.transportIdentity()).rejects.toThrow("unavailable");
      await enroll();
      const identity = await installation.transportIdentity();
      const repeated = await installation.transportIdentity();
      const row = await system(() =>
        prisma!.installationIdentity.findUniqueOrThrow({ where: { id: "local" } }),
      );
      const certificate = new X509Certificate(Buffer.from(identity.certificate, "base64"));
      expect(
        certificate.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      ).toBe(row.publicKey);
      expect(identity).toMatchObject({
        serverId,
        bindingVersion: row.bindingVersion,
        keyFingerprint: row.keyFingerprint,
      });
      expect(repeated.certificate).toBe(identity.certificate);
      expect(identity).not.toHaveProperty("privateKey");
      await system(() =>
        prisma!.installationIdentity.update({ where: { id: "local" }, data: { state: "pending" } }),
      );
      await expect(installation.transportIdentity()).rejects.toThrow("unavailable");
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
      authority = new WorkspaceAuthority(prisma!, installation, issuer, undefined, revocations);
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
      authority = new WorkspaceAuthority(prisma!, installation, issuer, undefined, revocations);
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
    it.each(["permission", "mapping"])(
      "rejects a same-binding same-iat stale %s before touching a newer personal watch",
      async (phase) => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(Math.floor(Date.now() / 1000) * 1000);
        await provision();
        if (phase === "mapping") server.restoreWorkspace();
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const other = new InstallationClient(prisma!, {
          issuer,
          encryptionKey: "fixture-encryption-material".repeat(3),
          keys,
          request: async (url, init) => {
            const response = await server.request(url, init);
            if (new URL(String(url)).pathname.endsWith("/servers/synchronize")) {
              enter();
              await hold;
            }
            return response;
          },
        });
        const stale = new WorkspaceAuthority(prisma!, other, issuer, undefined, revocations);
        const pending = stale.synchronize().then(
          () => undefined,
          (error: unknown) => error,
        );
        let client: Awaited<ReturnType<typeof personalClient>> | undefined;
        let watch: { signal: AbortSignal; dispose(): void } | undefined;
        try {
          await Promise.race([entered, pending]);
          if (phase === "permission") {
            server.revoke();
            await authority!.synchronize();
            server.readd();
          } else await authority!.provisionWorkspace(workspaceId);
          await authority!.synchronize();
          client = await personalClient(true);
          const device = (await stale.personal.device(client.device.id))!;
          expect(device).not.toBeNull();
          watch = await stale.personal.watch(device);
          expect(watch.signal.aborted).toBe(false);
          expect(
            (await stale.personalChallenge(device.id, "c".repeat(43))).target.bindingVersion,
          ).toBe(1);
          const latest = await system(() =>
            prisma!.installationIdentity.findUniqueOrThrow({ where: { id: "local" } }),
          );
          expect(latest.verifiedAt!.getTime()).toBe(Date.now());
          release();
          const error = await pending;
          expect(watch.signal.aborted).toBe(false);
          expect(String(error)).toContain("Workspace authority unavailable");
          expect(revokedDevices.has(device.id)).toBe(false);
          expect(await stale.personal.device(device.id)).not.toBeNull();
          expect(
            (await stale.personalChallenge(device.id, "d".repeat(43))).target.bindingVersion,
          ).toBe(1);
          expect(
            await system(() =>
              prisma!.personalWorkspaceDevice.findUniqueOrThrow({ where: { id: device.id } }),
            ),
          ).toHaveProperty("revokedAt", null);
          expect(stale.window.workspace(workspaceId)).toBeNull();
        } finally {
          release();
          await pending;
          watch?.dispose();
          client?.auth.disposeOidcDiscovery();
          stale.dispose();
          clock.mockRestore();
        }
      },
    );
    it.each([false, true])(
      "fences independent projection deadlines and exact registry policy (changed: %s)",
      async (registryChanged) => {
        await provision();
        const firstDb = createDb(process.env.DATABASE_URL!, { encryptContent: false, poolMax: 1 });
        const firstClient = new InstallationClient(firstDb.prisma, {
          issuer,
          encryptionKey: "fixture-encryption-material".repeat(3),
          request: server.request,
          keys,
        });
        const first = new WorkspaceAuthority(
          firstDb.prisma,
          firstClient,
          issuer,
          undefined,
          revocations,
        );
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const transaction = firstDb.prisma.$transaction.bind(firstDb.prisma) as (
          callback: unknown,
          options?: unknown,
        ) => Promise<unknown>;
        let calls = 0;
        const spy = vi.spyOn(firstDb.prisma, "$transaction").mockImplementation((async (
          callback: unknown,
          options?: unknown,
        ) => {
          if (++calls === 2) {
            enter();
            await hold;
          }
          return transaction(callback, options);
        }) as never);
        const pending = first.synchronize().then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        let clock: ReturnType<typeof vi.spyOn> | undefined;
        try {
          await Promise.race([entered, pending]);
          server.timeOffset(1);
          if (registryChanged) server.revokeDevice(randomUUID());
          const secondProjection = await authority!.synchronize();
          release();
          const result = await pending;
          if (registryChanged) {
            expect(String(result.error)).toContain("Workspace authority unavailable");
            expect(first.window.workspace(workspaceId)).toBeNull();
            return;
          }
          expect(result.error).toBeUndefined();
          expect(result.value!.bindingVersion).toBe(secondProjection.bindingVersion);
          expect(result.value!.verifiedAt).toBeLessThan(secondProjection.verifiedAt);
          expect(result.value!.expiresAt).toBeLessThan(secondProjection.expiresAt);
          expect(first.window.permits(workspaceId, "central-participant", admission)).toBe(true);
          expect(authority!.window.permits(workspaceId, "central-participant", admission)).toBe(
            true,
          );
          clock = vi.spyOn(Date, "now").mockReturnValue(result.value!.expiresAt * 1000 + 1);
          expect(first.window.permits(workspaceId, "central-participant", admission)).toBe(false);
          expect(authority!.window.permits(workspaceId, "central-participant", admission)).toBe(
            true,
          );
        } finally {
          clock?.mockRestore();
          release();
          await pending;
          spy.mockRestore();
          first.dispose();
          await firstDb.prisma.$disconnect();
          await firstDb.pool.end();
        }
      },
    );
    it("does not reopen personal memory or clear a newer global barrier after delayed restore IO loses its fence", async () => {
      await provision();
      const directory = await mkdtemp(path.join(tmpdir(), "ork-projection-restoration-"));
      const journal = new FilePersonalRevocations(directory);
      await journal.refuseInstallation();
      authority!.dispose();
      authority = new WorkspaceAuthority(prisma!, installation, issuer, undefined, journal);
      const firstDb = createDb(process.env.DATABASE_URL!, { encryptContent: false, poolMax: 1 });
      const firstClient = new InstallationClient(firstDb.prisma, {
        issuer,
        encryptionKey: "fixture-encryption-material".repeat(3),
        request: server.request,
        keys,
      });
      let enter!: () => void;
      let release!: () => void;
      let paused = false;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = new WorkspaceAuthority(firstDb.prisma, firstClient, issuer, undefined, {
        refuseInstallation: journal.refuseInstallation.bind(journal),
        revoked: journal.revoked.bind(journal),
        revoke: journal.revoke.bind(journal),
        restorationCheckpoint: journal.restorationCheckpoint.bind(journal),
        confirmRestoration: async (checkpoint) => {
          paused = true;
          enter();
          await hold;
          await journal.confirmRestoration(checkpoint);
        },
      });
      const confirmed = vi.spyOn(first.personal, "confirmed");
      const transaction = firstDb.prisma.$transaction.bind(firstDb.prisma) as (
        callback: unknown,
        options?: object,
      ) => Promise<unknown>;
      let calls = 0;
      const spy = vi
        .spyOn(firstDb.prisma, "$transaction")
        .mockImplementation((async (callback: unknown, options?: object) =>
          transaction(callback, ++calls === 2 ? { ...options, timeout: 100 } : options)) as never);
      const pending = first.synchronize().then(
        () => undefined,
        (error: unknown) => error,
      );
      let client: Awaited<ReturnType<typeof personalClient>> | undefined;
      let watch: { signal: AbortSignal; dispose(): void } | undefined;
      try {
        await Promise.race([entered, pending]);
        expect(paused).toBe(true);
        server.prepareReconnect();
        await installation.reconnectEnrollment("Installation", organizationId, (id, tx) =>
          authority!.refuseInstallation(id, true, tx),
        );
        server.approve();
        await installation.pollEnrollment();
        server.refuseSynchronization(200);
        await authority!.synchronize();
        server.restoreWorkspace();
        await authority!.synchronize();
        await authority!.provisionWorkspace(workspaceId);
        server.readd();
        await authority!.synchronize();
        client = await personalClient(true);
        const device = (await first.personal.device(client.device.id))!;
        expect(device).not.toBeNull();
        watch = await first.personal.watch(device);
        expect(watch.signal.aborted).toBe(false);
        await journal.refuseInstallation();
        const newBarrier = await journal.restorationCheckpoint(
          (await installation.configuration())!,
        );
        expect(newBarrier).toHaveLength(1);
        release();
        expect(String(await pending)).toMatch(/closed|expired/i);
        expect(confirmed).not.toHaveBeenCalled();
        expect(first.window.workspace(workspaceId)).toBeNull();
        expect(await journal.restorationCheckpoint((await installation.configuration())!)).toEqual(
          newBarrier,
        );
        expect(await first.personal.device(device.id)).toBeNull();
        expect(
          await system(() =>
            prisma!.personalWorkspaceDevice.findUniqueOrThrow({ where: { id: device.id } }),
          ),
        ).toHaveProperty("revokedAt", null);
      } finally {
        release();
        await pending;
        watch?.dispose();
        client?.auth.disposeOidcDiscovery();
        confirmed.mockRestore();
        spy.mockRestore();
        first.dispose();
        await firstDb.prisma.$disconnect();
        await firstDb.pool.end();
        await rm(directory, { recursive: true, force: true });
      }
    });
    it("rejects an old signed projection before restricting a fresh personal credential and watch", async () => {
      await provision();
      const old = (await installation.configuration())!;
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const other = new InstallationClient(prisma!, {
        issuer,
        encryptionKey: "fixture-encryption-material".repeat(3),
        keys,
        request: async (url, init) => {
          const response = await server.request(url, init);
          if (new URL(String(url)).pathname.endsWith("/servers/synchronize")) {
            enter();
            await hold;
          }
          return response;
        },
      });
      const stale = new WorkspaceAuthority(prisma!, other, issuer, undefined, revocations);
      const pending = stale.synchronize();
      const rejected = expect(pending).rejects.toThrow("Workspace authority unavailable");
      let client: Awaited<ReturnType<typeof personalClient>> | undefined;
      let watch: { signal: AbortSignal; dispose(): void } | undefined;
      try {
        await entered;
        server.prepareReconnect();
        await installation.reconnectEnrollment("Installation", organizationId, (id, tx) =>
          authority!.refuseInstallation(id, true, tx),
        );
        server.approve();
        await installation.pollEnrollment();
        server.refuseSynchronization(200);
        await authority!.synchronize();
        server.restoreWorkspace();
        await authority!.synchronize();
        await authority!.provisionWorkspace(workspaceId);
        server.readd();
        await authority!.synchronize();
        client = await personalClient(true);
        const device = (await stale.personal.device(client.device.id))!;
        expect(device).not.toBeNull();
        watch = await stale.personal.watch(device);
        expect(watch.signal.aborted).toBe(false);
        expect(
          (await stale.personalChallenge(device.id, "c".repeat(43))).target.bindingVersion,
        ).toBe(2);
        release();
        await rejected;
        expect(watch.signal.aborted).toBe(false);
        expect(await stale.invalidateProjection(old, [workspaceId])).toBe(false);
        expect(watch.signal.aborted).toBe(false);
        expect(revokedDevices.has(device.id)).toBe(false);
        expect(await stale.personal.device(device.id)).not.toBeNull();
        expect(
          (await stale.personalChallenge(device.id, "d".repeat(43))).target.bindingVersion,
        ).toBe(2);
        expect(
          await system(() =>
            prisma!.personalWorkspaceDevice.findUniqueOrThrow({ where: { id: device.id } }),
          ),
        ).toHaveProperty("revokedAt", null);
        expect(stale.window.workspace(workspaceId)).toBeNull();
      } finally {
        release();
        await pending.catch(() => undefined);
        watch?.dispose();
        client?.auth.disposeOidcDiscovery();
        stale.dispose();
      }
    });
    it("publishes only a bound failure fallback after rollback without a nested pool checkout", async () => {
      await provision();
      server.prepareReconnect();
      const original = (await installation.configuration())!;
      const single = createDb(process.env.DATABASE_URL!, { encryptContent: false, poolMax: 1 });
      const client = new InstallationClient(single.prisma, {
        issuer,
        encryptionKey: "fixture-encryption-material".repeat(3),
        request: server.request,
        keys,
      });
      const directory = await mkdtemp(path.join(tmpdir(), "ork-refusal-fallback-"));
      const journal = new FilePersonalRevocations(directory);
      const notices: string[] = [];
      const listener = await database!.pool.connect();
      const receive = (notice: { payload?: string }) => {
        if (notice.payload) notices.push(notice.payload);
      };
      listener.on("notification", receive);
      await listener.query("LISTEN orkbot_events");
      const fanout = {
        publish: async (topic: string, payload: string) => {
          await single.pool.query("SELECT pg_notify('orkbot_events', $1)", [
            JSON.stringify({ topic, payload }),
          ]);
        },
      };
      const failing = new WorkspaceAuthority(single.prisma, client, issuer, fanout as never, {
        refuseInstallation: async (scope) => {
          await journal.refuseInstallation(scope);
          throw new Error("fictional filesystem failure");
        },
        revoked: journal.revoked.bind(journal),
        revoke: journal.revoke.bind(journal),
        restorationCheckpoint: journal.restorationCheckpoint.bind(journal),
        confirmRestoration: journal.confirmRestoration.bind(journal),
      });
      let captured: typeof original | undefined;
      try {
        await expect(
          client.reconnectEnrollment(
            "Installation",
            organizationId,
            async (id, tx, configuration) => {
              captured = configuration;
              await failing.refuseInstallation(id, true, tx);
            },
          ),
        ).rejects.toThrow("fictional filesystem failure");
        expect(await client.configuration()).toEqual(original);
        expect(notices).toEqual([]);
        expect(await journal.restorationCheckpoint(original)).toHaveLength(1);
        // This is the failure-only CLI hook, after the transaction has released its connection.
        await failing.broadcastRefusal(captured!);
        await vi.waitFor(() => expect(notices).toHaveLength(1));
        const notice = JSON.parse(JSON.parse(notices[0]!).payload);
        expect(notice).toMatchObject({
          serverId,
          bindingVersion: 1,
          keyFingerprint: original.keyFingerprint,
          refused: true,
        });
        await client.reconnectEnrollment("Installation", organizationId, (id, tx) =>
          authority!.refuseInstallation(id, true, tx),
        );
        server.approve();
        await client.pollEnrollment();
        server.refuseSynchronization(200);
        await authority!.synchronize();
        const dispose = vi.spyOn(authority!.window, "dispose");
        const markers = [...restorationBarriers];
        await authority!.refuseInstallation(serverId, false, undefined, {
          ...original,
          bindingVersion: notice.bindingVersion,
          keyFingerprint: notice.keyFingerprint,
        });
        expect(dispose).not.toHaveBeenCalled();
        expect([...restorationBarriers]).toEqual(markers);
        expect(await journal.restorationCheckpoint((await client.configuration())!)).toEqual([]);
        dispose.mockRestore();
      } finally {
        failing.dispose();
        listener.off("notification", receive);
        await listener.query("UNLISTEN orkbot_events");
        listener.release();
        await single.prisma.$disconnect();
        await single.pool.end();
        await rm(directory, { recursive: true, force: true });
      }
    });
    it("does not apply a late filesystem refusal to a newer binding after its transaction expires", async () => {
      await provision();
      const original = (await installation.configuration())!;
      const directory = await mkdtemp(path.join(tmpdir(), "ork-expired-refusal-"));
      const journal = new FilePersonalRevocations(directory);
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const delayedJournal = {
        refuseInstallation: async (scope?: Parameters<typeof journal.refuseInstallation>[0]) => {
          enter();
          await hold;
          await journal.refuseInstallation(scope);
        },
        revoked: journal.revoked.bind(journal),
        revoke: journal.revoke.bind(journal),
        restorationCheckpoint: journal.restorationCheckpoint.bind(journal),
        confirmRestoration: journal.confirmRestoration.bind(journal),
      };
      const staleAuthority = new WorkspaceAuthority(
        prisma!,
        installation,
        issuer,
        undefined,
        delayedJournal,
      );
      let failure: unknown;
      const pending = system(() =>
        prisma!.$transaction(
          (tx) => staleAuthority.refuseInstallation(serverId, false, tx, original),
          { timeout: 100 },
        ),
      ).catch((error) => {
        failure = error;
      });
      try {
        await Promise.race([entered, pending]);
        server.prepareReconnect();
        await installation.reconnectEnrollment("Installation", organizationId, (id, tx) =>
          authority!.refuseInstallation(id, true, tx),
        );
        server.approve();
        await installation.pollEnrollment();
        server.refuseSynchronization(200);
        await authority!.synchronize();
        const next = (await installation.configuration())!;
        expect(next.bindingVersion).toBe(2);
        expect(await journal.restorationCheckpoint(next)).toEqual([]);
        release();
        await pending;
        expect(String(failure)).toMatch(/closed|expired/i);
        expect(await journal.restorationCheckpoint(original)).toHaveLength(1);
        expect(await journal.restorationCheckpoint(next)).toEqual([]);
        expect(await installation.configuration()).toEqual(next);
        await journal.refuseInstallation();
        expect(await journal.restorationCheckpoint(next)).toHaveLength(1);
      } finally {
        release();
        await pending;
        staleAuthority.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    });
    it("serializes a blocked revocation without a nested checkout on a one-connection pool", async () => {
      await provision();
      server.prepareReconnect();
      const single = createDb(process.env.DATABASE_URL!, { encryptContent: false, poolMax: 1 });
      const first = new InstallationClient(single.prisma, {
        issuer,
        encryptionKey: "fixture-encryption-material".repeat(3),
        request: server.request,
        keys,
      });
      const notifications: string[] = [];
      const listener = await database!.pool.connect();
      const receive = (notice: { payload?: string }) => {
        if (notice.payload) notifications.push(notice.payload);
      };
      listener.on("notification", receive);
      await listener.query("LISTEN orkbot_events");
      const firstAuthority = new WorkspaceAuthority(
        single.prisma,
        first,
        issuer,
        {
          publish: async () => {
            throw new Error("A transaction must not check out a second publisher connection");
          },
        } as never,
        revocations,
      );
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      let secondRefusals = 0;
      try {
        const firstAttempt = first.reconnectEnrollment(
          "Installation",
          organizationId,
          async (id, tx) => {
            await firstAuthority.refuseInstallation(id, true, tx);
            enter();
            await hold;
          },
        );
        await Promise.race([entered, firstAttempt]);
        let secondSent!: () => void;
        const sent = new Promise<void>((resolve) => {
          secondSent = resolve;
        });
        const other = new InstallationClient(prisma!, {
          issuer,
          encryptionKey: "fixture-encryption-material".repeat(3),
          keys,
          request: async (url, init) => {
            const response = await server.request(url, init);
            if (new URL(String(url)).pathname.endsWith("/servers/synchronize")) secondSent();
            return response;
          },
        });
        const secondAttempt = other.reconnectEnrollment(
          "Installation",
          organizationId,
          async (id, tx) => {
            secondRefusals++;
            await authority!.refuseInstallation(id, true, tx);
          },
        );
        const rejected = expect(secondAttempt).rejects.toThrow("Installation binding changed");
        await Promise.race([sent, secondAttempt]);
        expect(notifications).toEqual([]);
        release();
        await firstAttempt;
        await rejected;
        await vi.waitFor(() => expect(notifications.length).toBeGreaterThan(0));
        const event = JSON.parse(JSON.parse(notifications[0]!).payload);
        expect(event).toMatchObject({ serverId, bindingVersion: 1, refused: true });
        expect(event.keyFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(secondRefusals).toBe(0);
        server.approve();
        expect(await first.pollEnrollment()).toMatchObject({ bindingVersion: 2 });
      } finally {
        release();
        firstAuthority.dispose();
        listener.off("notification", receive);
        await listener.query("UNLISTEN orkbot_events");
        listener.release();
        await single.prisma.$disconnect();
        await single.pool.end();
      }
    });
    it("rejects a deferred old reconnect before revoking a newly acknowledged binding", async () => {
      await provision();
      let deliver!: () => void;
      let received!: () => void;
      const waiting = new Promise<void>((resolve) => {
        received = resolve;
      });
      const delayed = new Promise<void>((resolve) => {
        deliver = resolve;
      });
      const stale = new InstallationClient(prisma!, {
        issuer,
        encryptionKey: "fixture-encryption-material".repeat(3),
        keys,
        request: async (url, init) => {
          if (new URL(String(url)).pathname.endsWith("/servers/synchronize")) {
            received();
            await delayed;
            return Response.json({ error: "Refused old binding" }, { status: 401 });
          }
          return server.request(url, init);
        },
      });
      let staleRefusals = 0;
      const oldAttempt = stale.reconnectEnrollment(
        "Installation",
        organizationId,
        async (id, transaction) => {
          staleRefusals++;
          await authority!.refuseInstallation(id, true, transaction);
        },
      );
      const rejected = expect(oldAttempt).rejects.toThrow("Installation binding changed");
      await waiting;
      server.prepareReconnect();
      await installation.reconnectEnrollment("Installation", organizationId, (id, transaction) =>
        authority!.refuseInstallation(id, true, transaction),
      );
      server.approve();
      await installation.pollEnrollment();
      server.refuseSynchronization(200);
      await authority!.synchronize();
      await system(() =>
        prisma!.personalWorkspaceDevice.create({
          data: {
            id: "identity-test-fresh-reconnect-device",
            workspaceId,
            userId: "identity-test-user",
            centralSubject: "central-participant",
            membershipVersion: admission,
            registryVersion: 1,
            permissionVersion: 2,
            bindingVersion: 2,
            keyFingerprint: "f".repeat(64),
            publicKey: "newly-approved-device",
          },
        }),
      );
      const markers = [...restorationBarriers];
      deliver();
      await rejected;
      expect(staleRefusals).toBe(0);
      expect([...restorationBarriers]).toEqual(markers);
      expect(revokedDevices.has("identity-test-fresh-reconnect-device")).toBe(false);
      expect(
        await system(() =>
          prisma!.personalWorkspaceDevice.findUniqueOrThrow({
            where: { id: "identity-test-fresh-reconnect-device" },
          }),
        ),
      ).toHaveProperty("revokedAt", null);
      expect(await installation.configuration()).toMatchObject({ serverId, bindingVersion: 2 });
      // A late real fanout handler uses this same locked gate before touching memory, disk or DB.
      await authority!.refuseInstallation(serverId, false, undefined, {
        serverId,
        organizationId,
        bindingVersion: 1,
        keyFingerprint: (await installation.configuration())!.keyFingerprint,
      });
      expect([...restorationBarriers]).toEqual(markers);
      expect(
        await system(() =>
          prisma!.personalWorkspaceDevice.findUniqueOrThrow({
            where: { id: "identity-test-fresh-reconnect-device" },
          }),
        ),
      ).toHaveProperty("revokedAt", null);
    });
    it("reconnects only a centrally refused binding and preserves data without reviving old admission", async () => {
      await provision();
      const local = () =>
        system(async () => ({
          organization: await prisma!.organization.findUniqueOrThrow({
            where: { id: "identity-test-org" },
          }),
          space: await prisma!.space.findUniqueOrThrow({ where: { id: "identity-test-space" } }),
          members: await prisma!.member.findMany({
            where: { organizationId: "identity-test-org" },
          }),
          spaceMembers: await prisma!.spaceMember.findMany({
            where: { spaceId: "identity-test-space" },
          }),
        }));
      const before = await local();
      const original = await system(() =>
        prisma!.installationIdentity.findUniqueOrThrow({ where: { id: "local" } }),
      );
      const running = await authority!.work("identity-test-space", "identity-test-user", admission);
      expect(running).not.toBeNull();
      await expect(
        installation.reconnectEnrollment("Installation", organizationId, (serverId, transaction) =>
          authority!.refuseInstallation(serverId, true, transaction),
        ),
      ).rejects.toThrow("Disconnect this installation through Accounts first");
      server.refuseSynchronization(503);
      await expect(
        installation.reconnectEnrollment("Installation", organizationId, (serverId, transaction) =>
          authority!.refuseInstallation(serverId, true, transaction),
        ),
      ).rejects.toThrow("503");
      expect(
        await system(() =>
          prisma!.installationIdentity.findUniqueOrThrow({ where: { id: "local" } }),
        ),
      ).toEqual(original);
      expect(running!.signal.aborted).toBe(false);
      expect(restorationBarriers.size).toBe(0);
      await expect(
        installation.reconnectEnrollment("Installation", randomUUID(), (serverId, transaction) =>
          authority!.refuseInstallation(serverId, true, transaction),
        ),
      ).rejects.toThrow("organization selection changed");
      await system(async () => {
        await prisma!.personalWorkspaceDevice.create({
          data: {
            id: "identity-test-reconnect-device",
            workspaceId,
            userId: "identity-test-user",
            centralSubject: "central-participant",
            membershipVersion: admission,
            registryVersion: 1,
            permissionVersion: 1,
            bindingVersion: 1,
            keyFingerprint: original.keyFingerprint,
            publicKey: "fictional-existing-device-key",
          },
        });
        await prisma!.aIConnectionAdministrator.create({
          data: { accountKey: "identity-test-reconnect-admin", bindingVersion: 1 },
        });
        await prisma!.serverAIConnection.create({
          data: {
            id: "identity-test-reconnect-connection",
            localOrganizationId: "identity-test-org",
            label: "Existing account",
            provider: "fixture",
            models: ["model"],
            secretId: "retained-secret-id",
            secretRef: "fictional-encrypted-reference",
          },
        });
        await prisma!.workspaceAIConnection.create({
          data: {
            spaceId: "identity-test-space",
            connectionId: "identity-test-reconnect-connection",
            enabled: true,
            available: true,
            allowedModels: ["model"],
            bindingVersion: 1,
          },
        });
      });
      server.prepareReconnect();
      const pending = await installation.reconnectEnrollment(
        "Installation",
        organizationId,
        (serverId, transaction) => authority!.refuseInstallation(serverId, true, transaction),
      );
      expect(running!.signal.aborted).toBe(true);
      expect(restorationBarriers.size).toBe(1);
      running!.dispose();
      expect(pending.keyFingerprint).toBe(original.keyFingerprint);
      const recovering = await system(() =>
        prisma!.installationIdentity.findUniqueOrThrow({ where: { id: "local" } }),
      );
      expect(recovering.operationId).not.toBe(original.operationId);
      expect(recovering.challenge).not.toBe(original.challenge);
      expect(recovering).toMatchObject({
        serverId,
        centralOrganizationId: organizationId,
        publicKey: original.publicKey,
        privateKeyCipher: original.privateKeyCipher,
        localOrganizationId: original.localOrganizationId,
        state: "enrolling",
      });
      expect(await installation.pollEnrollment()).toBeNull();
      expect(await installation.configuration()).toBeNull();
      expect(await local()).toEqual(before);
      server.approve();
      server.bindingVersion(1);
      await expect(installation.pollEnrollment()).rejects.toThrow("proof does not match");
      expect(await installation.configuration()).toBeNull();
      server.bindingVersion(2);
      expect(await installation.pollEnrollment()).toMatchObject({ serverId, bindingVersion: 2 });
      server.refuseSynchronization(200);
      await authority!.synchronize();
      server.restoreWorkspace();
      await authority!.synchronize();
      await authority!.provisionWorkspace(workspaceId);
      await authority!.synchronize();
      expect(await local()).toEqual(before);
      expect(
        await authority!.work("identity-test-space", "identity-test-user", admission),
      ).toBeNull();
      await system(async () => {
        expect(await prisma!.centralWorkspaceAccess.count({ where: { active: true } })).toBe(0);
        expect(
          await prisma!.personalWorkspaceDevice.findUniqueOrThrow({
            where: { id: "identity-test-reconnect-device" },
          }),
        ).toHaveProperty("revokedAt", expect.any(Date));
        expect(await prisma!.aIConnectionAdministrator.count()).toBe(0);
        expect(
          await prisma!.workspaceAIConnection.findUniqueOrThrow({
            where: {
              spaceId_connectionId: {
                spaceId: "identity-test-space",
                connectionId: "identity-test-reconnect-connection",
              },
            },
          }),
        ).toMatchObject({ enabled: false, available: false, bindingVersion: 1 });
        expect(
          await prisma!.serverAIConnection.findUniqueOrThrow({
            where: { id: "identity-test-reconnect-connection" },
          }),
        ).toMatchObject({
          secretId: "retained-secret-id",
          secretRef: "fictional-encrypted-reference",
        });
      });
    });

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
      authority = new WorkspaceAuthority(prisma!, installation, issuer, undefined, revocations);
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
    const personalClient = async (reuseInstallation = false) => {
      if (!reuseInstallation) await provision();
      const auth = createAuth(prisma!, {
        secret: "fixture-auth-material".repeat(3),
        baseURL: "https://installation.example.test",
        webOrigin: "https://installation.example.test",
        nativeAccounts: { issuer },
        passwordAuth: false,
        signupsEnabled: "false",
        signupAllowlist: "",
        workspaceAuthority: authority!,
      });
      const call = (path: string, body: object, token?: string) =>
        system(() =>
          auth.handler(
            new Request(`https://installation.example.test/api/auth/${path}`, {
              method: "POST",
              headers: {
                origin: "https://installation.example.test",
                "content-type": "application/json",
                ...(token ? { authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify(body),
            }),
          ),
        );
      const deviceKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const device = {
        id: randomUUID(),
        publicKey: deviceKey.publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64url"),
      };
      const configuration = (await installation.configuration())!;
      const target = { ...configuration, workspaceId, deviceId: device.id };
      const signature = (message: string) =>
        sign("sha256", Buffer.from(message), deviceKey.privateKey).toString("base64url");
      const { challenge } = (await (await call("native/workspace/challenge", {})).json()) as {
        challenge: string;
      };
      const grant = await server.loginGrant(challenge, undefined, {
        organization_type: "personal",
        personal_device: { id: device.id, public_key: device.publicKey, registry_version: 1 },
      });
      const deviceSignature = signature(
        personalActivationMessage(
          target,
          challenge,
          createHash("sha256").update(grant).digest("hex"),
        ),
      );
      expect((await call("native/workspace/complete", { challenge, grant })).status).toBe(403);
      const response = await call("native/workspace/complete", {
        challenge,
        grant,
        deviceSignature,
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as { token: string; personalDevice: { id: string } };
      expect(result.personalDevice.id).toBe(device.id);
      const session = await system(() =>
        prisma!.session.findUniqueOrThrow({ where: { token: result.token.split(".")[0]! } }),
      );
      return { auth, call, device, target, signature, session, token: result.token };
    };

    it("renews only an activated personal device offline across process restart and fences its queued work", async () => {
      const client = await personalClient();
      try {
        const bot = await system(() =>
          prisma!.bot.create({
            data: {
              userId: "identity-test-user",
              spaceId: "identity-test-space",
              name: "Offline",
              color: "blue",
            },
          }),
        );
        const thread = await system(() =>
          prisma!.thread.create({
            data: { userId: "identity-test-user", spaceId: "identity-test-space", botId: bot.id },
          }),
        );
        await system(() =>
          prisma!.centralWorkspaceBinding.update({
            where: { id: workspaceId },
            data: { validUntil: new Date(0) },
          }),
        );
        authority!.dispose();
        authority = new WorkspaceAuthority(prisma!, installation, issuer, undefined, revocations);
        // Recompose authentication with the restarted authority.
        client.auth.disposeOidcDiscovery();
        const auth = createAuth(prisma!, {
          secret: "fixture-auth-material".repeat(3),
          baseURL: "https://installation.example.test",
          webOrigin: "https://installation.example.test",
          passwordAuth: false,
          signupsEnabled: "false",
          signupAllowlist: "",
          nativeAccounts: { issuer },
          workspaceAuthority: authority,
        });
        const call = (path: string, body: object) =>
          system(() =>
            auth.handler(
              new Request(
                `https://installation.example.test/api/auth/native/workspace/personal/${path}`,
                {
                  method: "POST",
                  headers: {
                    origin: "https://installation.example.test",
                    "content-type": "application/json",
                  },
                  body: JSON.stringify(body),
                },
              ),
            ),
          );
        try {
          expect(await authority.session("identity-test-session", "identity-test-user")).toBeNull();
          expect(await authority.session(client.session.id, "identity-test-user")).toMatchObject({
            workspaceId,
            personalDeviceId: client.device.id,
          });
          expect(
            await runAsTenant(
              { userId: "identity-test-user", spaceId: "identity-test-space" },
              () => prisma!.thread.findUnique({ where: { id: thread.id } }),
            ),
          ).not.toBeNull();
          const centralCalls = server.calls();
          const challengeResponse = await call("challenge", { deviceId: client.device.id });
          expect(challengeResponse.status).toBe(200);
          const challenge = (await challengeResponse.json()) as {
            challenge: string;
            publicKey: string;
            signature: string;
          };
          expect(
            verify(
              "sha256",
              Buffer.from(personalServerMessage(client.target, challenge.challenge)),
              { key: Buffer.from(challenge.publicKey, "base64url"), type: "spki", format: "der" },
              Buffer.from(challenge.signature, "base64url"),
            ),
          ).toBe(true);
          expect(
            (
              await call("complete", {
                deviceId: client.device.id,
                challenge: challenge.challenge,
                signature: "a".repeat(90),
              })
            ).status,
          ).toBe(403);
          const proof = {
            deviceId: client.device.id,
            challenge: challenge.challenge,
            signature: client.signature(personalOfflineMessage(client.target, challenge.challenge)),
          };
          expect((await call("complete", proof)).status).toBe(200);
          expect((await call("complete", proof)).status).toBe(403);
          expect(server.calls()).toBe(centralCalls);
          const task = await system(() =>
            prisma!.task.create({
              data: {
                userId: bot.userId,
                spaceId: bot.spaceId,
                botId: bot.id,
                threadId: thread.id,
                prompt: "Fixture",
                status: "queued",
              },
            }),
          );
          const queued = await runAsTenant(
            { userId: bot.userId, spaceId: bot.spaceId, personalDeviceId: client.device.id },
            () =>
              prisma!.run.create({
                data: {
                  userId: bot.userId,
                  spaceId: bot.spaceId,
                  botId: bot.id,
                  threadId: thread.id,
                  taskId: task.id,
                  trigger: "user",
                  status: "queued",
                },
              }),
          );
          expect(queued).toMatchObject({
            personalDeviceId: client.device.id,
            requiredReaderVersion: 5,
          });
          const running = await authority.execution({
            userId: bot.userId,
            spaceId: bot.spaceId,
            workspaceId,
            membershipVersion: admission,
            personalDeviceId: client.device.id,
          });
          expect(running?.signal.aborted).toBe(false);
          const oldReader = await system(() =>
            prisma!.$transaction(async (tx) => {
              await tx.$queryRaw`SELECT set_config('app.run_reader_version', '4', true)`;
              return tx.run.updateMany({
                where: { id: queued.id },
                data: { status: "leased", leaseOwner: "old" },
              });
            }),
          );
          expect(oldReader.count).toBe(0);
          await expect(
            system(() =>
              prisma!.run.update({
                where: { id: queued.id },
                data: { personalDeviceId: randomUUID() },
              }),
            ),
          ).rejects.toThrow("immutable");
          server.revoke();
          await authority.synchronize();
          expect(running?.signal.aborted).toBe(true);
          running?.dispose();
          expect(await authority.session(client.session.id, bot.userId)).toBeNull();
          expect(
            await authority.execution({
              userId: bot.userId,
              spaceId: bot.spaceId,
              workspaceId,
              membershipVersion: admission,
              personalDeviceId: client.device.id,
            }),
          ).toBeNull();
          expect((await call("challenge", { deviceId: client.device.id })).status).toBe(403);
          expect(
            await runAsTenant({ userId: bot.userId, spaceId: bot.spaceId }, () =>
              prisma!.thread.findUnique({ where: { id: thread.id } }),
            ),
          ).toBeNull();
          server.readd();
          await authority.synchronize();
          expect(await authority.personal.device(client.device.id)).toBeNull();
        } finally {
          auth.disposeOidcDiscovery();
        }
      } finally {
        client.auth.disposeOidcDiscovery();
      }
    });

    it("requires fresh central verification after restoration and retains later revocations", async () => {
      const client = await personalClient();
      try {
        restorationBarriers.add("restore-one");
        authority!.dispose();
        authority = new WorkspaceAuthority(prisma!, installation, issuer, undefined, revocations);
        expect(await authority.personal.device(client.device.id)).toBeNull();
        await expect(
          authority.personalChallenge(client.device.id, "c".repeat(43)),
        ).rejects.toThrow();
        server.refuseSynchronization(503);
        await expect(authority.synchronize()).rejects.toThrow();
        expect(restorationBarriers.size).toBe(1);
        expect(await authority.personal.device(client.device.id)).toBeNull();
        server.refuseSynchronization(200);
        await authority.synchronize();
        expect(restorationBarriers.size).toBe(0);
        expect(await authority.personal.device(client.device.id)).not.toBeNull();
        restorationBarriers.add("restore-two");
        server.revokeDevice(client.device.id);
        await authority.synchronize();
        expect(restorationBarriers.size).toBe(0);
        expect(await authority.personal.device(client.device.id)).toBeNull();
        expect(revokedDevices.has(client.device.id)).toBe(true);
      } finally {
        client.auth.disposeOidcDiscovery();
      }
    });

    it("does not clear the restoration barrier when persisting the verified projection fails", async () => {
      const client = await personalClient();
      try {
        restorationBarriers.add("restore-persistence-failure");
        await system(() =>
          prisma!.installationIdentity.update({
            where: { id: "local" },
            data: { verifiedAt: new Date(Date.now() + 60_000) },
          }),
        );
        authority!.dispose();
        authority = new WorkspaceAuthority(prisma!, installation, issuer, undefined, revocations);
        await expect(authority.synchronize()).rejects.toThrow();
        expect(restorationBarriers.size).toBe(1);
        expect(await authority.personal.device(client.device.id)).toBeNull();
        await system(() =>
          prisma!.installationIdentity.update({
            where: { id: "local" },
            data: { verifiedAt: new Date(0) },
          }),
        );
        await authority.synchronize();
        expect(restorationBarriers.size).toBe(0);
        expect(await authority.personal.device(client.device.id)).not.toBeNull();
      } finally {
        client.auth.disposeOidcDiscovery();
      }
    });

    it("distinguishes an older device-registry snapshot from an explicit revocation", async () => {
      const client = await personalClient();
      try {
        const projection = await authority!.synchronize();
        await authority!.personal.restrict({
          ...projection,
          workspaces: projection.workspaces.map((workspace) => ({
            ...workspace,
            personalDeviceVersion: 0,
            personalDevices: [],
          })),
        });
        expect(await authority!.personal.device(client.device.id)).not.toBeNull();
        const device = (await authority!.personal.device(client.device.id))!;
        const running = await authority!.personal.watch(device);
        server.revokeDevice(client.device.id);
        await authority!.synchronize();
        expect(running.signal.aborted).toBe(true);
        running.dispose();
        expect(await authority!.personal.device(client.device.id)).toBeNull();
        // A stale database projection cannot undo the already received revocation.
        await system(() =>
          prisma!.personalWorkspaceDevice.update({
            where: { id: client.device.id },
            data: { revokedAt: null },
          }),
        );
        authority!.dispose();
        authority = new WorkspaceAuthority(prisma!, installation, issuer, undefined, revocations);
        expect(await authority.personal.device(client.device.id)).toBeNull();
      } finally {
        client.auth.disposeOidcDiscovery();
      }
    });

    it.each([400, 401, 426])(
      "persists personal revocation after a known central refusal (%s)",
      async (status) => {
        const client = await personalClient();
        try {
          server.refuseSynchronization(status);
          await expect(authority!.synchronize()).rejects.toThrow();
          expect(await authority!.personal.device(client.device.id)).toBeNull();
          const saved = await system(() =>
            prisma!.personalWorkspaceDevice.findUniqueOrThrow({ where: { id: client.device.id } }),
          );
          expect(saved.revokedAt).not.toBeNull();
        } finally {
          client.auth.disposeOidcDiscovery();
        }
      },
    );

    it("cannot borrow another active personal device after the current device signs out offline", async () => {
      const first = await personalClient();
      const second = await personalClient(true);
      try {
        await system(() =>
          prisma!.centralWorkspaceBinding.update({
            where: { id: workspaceId },
            data: { validUntil: new Date(0) },
          }),
        );
        authority!.window.dispose();
        expect(await authority!.session(first.session.id, "identity-test-user")).not.toBeNull();
        expect(await authority!.session(second.session.id, "identity-test-user")).not.toBeNull();
        expect((await first.call("sign-out", {}, first.token)).status).toBe(200);
        expect(await authority!.session(first.session.id, "identity-test-user")).toBeNull();
        expect(await authority!.session(second.session.id, "identity-test-user")).not.toBeNull();
        const [retired, retained] = await Promise.all(
          [first, second].map((client) =>
            authority!.execution({
              spaceId: "identity-test-space",
              userId: "identity-test-user",
              workspaceId,
              membershipVersion: admission,
              personalDeviceId: client.device.id,
            }),
          ),
        );
        expect(retired).toBeNull();
        expect(retained?.signal.aborted).toBe(false);
        retained?.dispose();
        const retiredWatch = await authority!.watchSession({
          workspaceId,
          subject: "central-participant",
          revision: admission,
          personalDeviceId: first.device.id,
        });
        expect(retiredWatch.signal.aborted).toBe(true);
        retiredWatch.dispose();
      } finally {
        first.auth.disposeOidcDiscovery();
        second.auth.disposeOidcDiscovery();
      }
    });

    it("removes the personal credential on explicit logout without turning session expiry into revocation", async () => {
      const client = await personalClient();
      try {
        expect((await client.call("sign-out", {}, client.token)).status).toBe(200);
        expect(await authority!.personal.device(client.device.id)).toBeNull();
        const saved = await system(() =>
          prisma!.personalWorkspaceDevice.findUniqueOrThrow({ where: { id: client.device.id } }),
        );
        expect(saved.revokedAt).not.toBeNull();
        expect(
          (await client.call("native/workspace/personal/challenge", { deviceId: client.device.id }))
            .status,
        ).toBe(403);
      } finally {
        client.auth.disposeOidcDiscovery();
      }
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
      authority = new WorkspaceAuthority(prisma!, installation, issuer, undefined, revocations);
      expect(await authority.session("identity-test-session", "identity-test-user")).toBeNull();
      expect(await authority.work("identity-test-space", "identity-test-user")).toBeNull();
      await authority.synchronize();
      expect(await authority.session("identity-test-session", "identity-test-user")).not.toBeNull();
    });
  },
);
