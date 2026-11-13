// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash, randomUUID } from "node:crypto";
import type { RealtimeFanout } from "@orkbot/adapter-kit";
import type { WorkspaceProjection } from "@orkbot/contracts";
import {
  IDENTITY_LOGIN_PURPOSE,
  IDENTITY_PROJECTION_PURPOSE,
  personalActivationMessage,
  personalDeviceSchema,
  workspaceProjectionSchema,
} from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { runAsSystem } from "@orkbot/db";
import type { InstallationClient } from "./installation-client.js";
import { InstallationRequestError } from "./installation-client.js";
import type { NativeLoginGrant, NativeLoginIdentity } from "./native-accounts-login.js";
import { oidcAccountSubject } from "./oidc.js";
import { personalDeviceKey, personalDeviceSignature } from "./personal-device-key.js";
import type { PersonalRevocations } from "./personal-revocations.js";
import { PersonalWorkspaceAccess } from "./personal-workspace-access.js";
import { WorkspaceAuthorityWindow } from "./workspace-authority-window.js";

const refused = () => new Error("Workspace authority unavailable");

/** Central projections control admission; local IDs, settings and data remain on this installation. */
export class WorkspaceAuthority {
  readonly window = new WorkspaceAuthorityWindow();
  readonly personal: PersonalWorkspaceAccess;
  readonly processId = randomUUID();
  constructor(
    private readonly prisma: PrismaClient,
    private readonly installation: InstallationClient,
    private readonly issuer: string,
    private readonly realtime?: RealtimeFanout,
    personalRevocations?: PersonalRevocations,
  ) {
    this.personal = new PersonalWorkspaceAccess(prisma, installation, personalRevocations);
  }

  active(): Promise<boolean> {
    return this.installation.registered();
  }

  async synchronize(): Promise<WorkspaceProjection> {
    const configuration = await this.installation.configuration();
    if (!configuration) throw refused();
    const { response, nonce, startedAt } = await this.installation
      .signedRequest("/servers/synchronize", { personalDeviceProtocol: 1 })
      .catch(async (error) => {
        if (
          error instanceof InstallationRequestError &&
          [400, 401, 403, 409, 410, 426].includes(error.status)
        ) {
          this.window.dispose();
          await this.personal.refuseInstallation();
        }
        throw error;
      });
    const claims = await this.installation.verify(
      response.grant,
      IDENTITY_PROJECTION_PURPOSE,
      configuration,
    );
    const projection = workspaceProjectionSchema.parse({
      serverId: claims.serverId,
      organizationId: claims.organizationId,
      bindingVersion: claims.bindingVersion,
      keyFingerprint: claims.keyFingerprint,
      verifiedAt: claims.verifiedAt,
      expiresAt: claims.expiresAt,
      workspaces: claims.workspaces,
    });
    if (
      claims.nonce !== nonce ||
      claims.sub !== configuration.serverId ||
      claims.iat !== projection.verifiedAt ||
      claims.exp !== projection.expiresAt ||
      projection.serverId !== configuration.serverId ||
      projection.organizationId !== configuration.organizationId ||
      projection.bindingVersion !== configuration.bindingVersion ||
      projection.keyFingerprint !== configuration.keyFingerprint
    )
      throw refused();
    this.window.validate(projection, startedAt);
    // A received revocation takes effect even if persisting its projection subsequently fails.
    const changed = new Set(this.window.restrict(projection, startedAt));
    for (const id of changed) this.personal.invalidate(id);
    await this.personal.restrict(projection);
    try {
      await runAsSystem("persist a freshly verified workspace projection", () =>
        this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM installation_identity WHERE id = 'local' FOR UPDATE`;
          const identity = await tx.installationIdentity.findUniqueOrThrow({
            where: { id: "local" },
          });
          if (
            identity.state !== "ready" ||
            identity.issuer !== this.issuer ||
            identity.serverId !== projection.serverId ||
            identity.centralOrganizationId !== projection.organizationId ||
            identity.bindingVersion !== projection.bindingVersion ||
            identity.keyFingerprint !== projection.keyFingerprint ||
            (identity.verifiedAt && identity.verifiedAt.getTime() > projection.verifiedAt * 1000)
          )
            throw refused();
          const previous = await tx.centralWorkspaceBinding.findMany();
          for (const binding of previous) {
            const workspace = projection.workspaces.find((value) => value.id === binding.id);
            if (
              !workspace ||
              workspace.permissionVersion !== binding.permissionVersion ||
              workspace.state !== binding.state ||
              projection.bindingVersion !== binding.bindingVersion
            )
              changed.add(binding.id);
            if (
              workspace &&
              (workspace.permissionVersion < binding.permissionVersion ||
                workspace.operationId !== binding.operationId ||
                (workspace.localOrganizationId &&
                  workspace.localOrganizationId !== binding.localOrganizationId) ||
                (workspace.localWorkspaceId && workspace.localWorkspaceId !== binding.spaceId))
            )
              throw refused();
            await tx.centralWorkspaceAccess.updateMany({
              where: { workspaceId: binding.id },
              data: { active: false },
            });
            if (!workspace) {
              await tx.centralWorkspaceBinding.update({
                where: { id: binding.id },
                data: { state: "disabled", validUntil: new Date(0) },
              });
              continue;
            }
            const ready =
              workspace.state === "ready" &&
              workspace.localOrganizationId === binding.localOrganizationId &&
              workspace.localWorkspaceId === binding.spaceId;
            await tx.centralWorkspaceBinding.update({
              where: { id: binding.id },
              data: {
                state: ready ? "ready" : workspace.state === "ready" ? "failed" : workspace.state,
                bindingVersion: projection.bindingVersion,
                permissionVersion: workspace.permissionVersion,
                members: workspace.members,
                verifiedAt: new Date(projection.verifiedAt * 1000),
                validUntil: new Date(projection.expiresAt * 1000),
              },
            });
            if (!ready) continue;
            for (const member of workspace.members) {
              const accounts = await tx.account.findMany({
                where: {
                  providerId: "oidc",
                  accountId: oidcAccountSubject(this.issuer, member.userId),
                },
                select: { userId: true },
              });
              const users = new Set(accounts.map((account) => account.userId));
              if (users.size > 1) throw refused();
              const userId = accounts[0]?.userId;
              if (!userId) continue;
              await tx.member.upsert({
                where: {
                  organizationId_userId: { organizationId: binding.localOrganizationId, userId },
                },
                create: {
                  id: randomUUID(),
                  organizationId: binding.localOrganizationId,
                  userId,
                  role: "member",
                  createdAt: new Date(),
                },
                update: { role: "member" },
              });
              await tx.spaceMember.upsert({
                where: { spaceId_userId: { spaceId: binding.spaceId, userId } },
                create: {
                  id: randomUUID(),
                  organizationId: binding.localOrganizationId,
                  spaceId: binding.spaceId,
                  userId,
                  role: member.role,
                  createdAt: new Date(),
                },
                update: { role: member.role },
              });
              await tx.centralWorkspaceAccess.upsert({
                where: { workspaceId_userId: { workspaceId: binding.id, userId } },
                create: {
                  workspaceId: binding.id,
                  userId,
                  centralSubject: member.userId,
                  role: member.role,
                  membershipVersion: member.accessVersion,
                  active: true,
                },
                update: {
                  centralSubject: member.userId,
                  role: member.role,
                  membershipVersion: member.accessVersion,
                  active: true,
                },
              });
            }
          }
          await tx.installationIdentity.update({
            where: { id: "local" },
            data: {
              projectionGrant: String(response.grant),
              verifiedAt: new Date(projection.verifiedAt * 1000),
              validUntil: new Date(projection.expiresAt * 1000),
            },
          });
        }),
      );
    } finally {
      if (this.realtime && changed.size) {
        const ids = [...changed];
        for (let i = 0; i < ids.length; i += 64)
          await this.realtime.publish(
            `installation-authority:${configuration.serverId}`,
            JSON.stringify({ source: this.processId, ids: ids.slice(i, i + 64) }),
          );
      }
    }
    this.window.apply(projection, startedAt);
    this.personal.confirmed(projection.workspaces.map((workspace) => workspace.id));
    return projection;
  }

  /** Provision only new local data. Existing installations require an explicit operator mapping. */
  async provisionWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.window.workspace(workspaceId);
    const configuration = await this.installation.configuration();
    if (!workspace || !configuration || !["provisioning", "ready"].includes(workspace.state))
      throw refused();
    const mapping = await runAsSystem(
      "reserve a durable local workspace provisioning operation",
      () =>
        this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM installation_identity WHERE id = 'local' FOR UPDATE`;
          const identity = await tx.installationIdentity.findUniqueOrThrow({
            where: { id: "local" },
          });
          if (
            identity.state !== "ready" ||
            identity.serverId !== configuration.serverId ||
            identity.bindingVersion !== configuration.bindingVersion
          )
            throw refused();
          const existing = await tx.centralWorkspaceBinding.findUnique({
            where: { id: workspaceId },
          });
          if (existing) {
            if (
              existing.operationId !== workspace.operationId ||
              existing.bindingVersion !== configuration.bindingVersion ||
              existing.localOrganizationId !== identity.localOrganizationId
            )
              throw refused();
            return { localOrganizationId: existing.localOrganizationId, spaceId: existing.spaceId };
          }
          // A missing local receipt is never repaired by guessing from centrally recorded names or IDs.
          if (workspace.localOrganizationId || workspace.localWorkspaceId) throw refused();
          let localOrganizationId = identity.localOrganizationId;
          if (!localOrganizationId) {
            if (await tx.organization.count())
              throw new Error("Explicit local organization mapping required");
            localOrganizationId = randomUUID();
            await tx.organization.create({
              data: {
                id: localOrganizationId,
                name: "Organization",
                slug: randomUUID(),
                createdAt: new Date(),
              },
            });
            await tx.installationIdentity.update({
              where: { id: "local" },
              data: { localOrganizationId },
            });
          }
          const spaceId = randomUUID();
          await tx.space.create({
            data: {
              id: spaceId,
              organizationId: localOrganizationId,
              name: workspace.name.slice(0, 60),
            },
          });
          await tx.centralWorkspaceBinding.create({
            data: {
              id: workspaceId,
              serverId: configuration.serverId,
              centralOrganizationId: configuration.organizationId,
              localOrganizationId,
              spaceId,
              operationId: workspace.operationId,
              bindingVersion: configuration.bindingVersion,
              permissionVersion: workspace.permissionVersion,
              state: "provisioning",
              members: [],
              verifiedAt: new Date(0),
              validUntil: new Date(0),
            },
          });
          return { localOrganizationId, spaceId };
        }),
    );
    await this.mapWorkspace(workspaceId, mapping.localOrganizationId, mapping.spaceId);
  }

  /** Called only after an operator chooses existing IDs or a clean installation creates new IDs. */
  async mapWorkspace(
    workspaceId: string,
    localOrganizationId: string,
    spaceId: string,
  ): Promise<void> {
    const workspace = this.window.workspace(workspaceId);
    const configuration = await this.installation.configuration();
    if (
      !workspace ||
      !configuration ||
      !["provisioning", "ready"].includes(workspace.state) ||
      (workspace.localOrganizationId && workspace.localOrganizationId !== localOrganizationId) ||
      (workspace.localWorkspaceId && workspace.localWorkspaceId !== spaceId)
    )
      throw refused();
    await runAsSystem("persist explicit central-to-local workspace mapping", () =>
      this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM installation_identity WHERE id = 'local' FOR UPDATE`;
        const identity = await tx.installationIdentity.findUniqueOrThrow({
          where: { id: "local" },
        });
        if (
          identity.state !== "ready" ||
          identity.serverId !== configuration.serverId ||
          identity.bindingVersion !== configuration.bindingVersion ||
          (identity.localOrganizationId && identity.localOrganizationId !== localOrganizationId)
        )
          throw refused();
        const space = await tx.space.findUnique({
          where: { id: spaceId },
          select: { organizationId: true, deletingAt: true },
        });
        if (!space || space.organizationId !== localOrganizationId || space.deletingAt)
          throw refused();
        const existing = await tx.centralWorkspaceBinding.findUnique({
          where: { id: workspaceId },
        });
        if (
          existing &&
          (existing.spaceId !== spaceId ||
            existing.localOrganizationId !== localOrganizationId ||
            existing.operationId !== workspace.operationId)
        )
          throw refused();
        await tx.centralWorkspaceBinding.upsert({
          where: { id: workspaceId },
          create: {
            id: workspaceId,
            serverId: configuration.serverId,
            centralOrganizationId: configuration.organizationId,
            localOrganizationId,
            spaceId,
            operationId: workspace.operationId,
            bindingVersion: configuration.bindingVersion,
            permissionVersion: workspace.permissionVersion,
            state: "provisioning",
            members: [],
            verifiedAt: new Date(0),
            validUntil: new Date(0),
          },
          update: {},
        });
        await tx.installationIdentity.update({
          where: { id: "local" },
          data: { localOrganizationId },
        });
      }),
    );
    const { response } = await this.installation.signedRequest("/workspaces/acknowledge", {
      operationId: workspace.operationId,
      localOrganizationId,
      localWorkspaceId: spaceId,
    });
    const confirmed = response.workspace as { id?: unknown; state?: unknown } | undefined;
    if (confirmed?.id !== workspaceId || confirmed.state !== "ready") throw refused();
    // A server acknowledgement cannot itself issue workspace access. Synchronization supplies it.
  }

  async login(
    grant: string,
    challenge: string,
    deviceSignature?: unknown,
  ): Promise<NativeLoginGrant> {
    const configuration = await this.installation.configuration();
    if (!configuration || grant.length > 16 * 1024) throw refused();
    const claims = await this.installation.verify(grant, IDENTITY_LOGIN_PURPOSE, configuration);
    if (
      claims.nonce !== challenge ||
      claims.server_id !== configuration.serverId ||
      claims.organization_id !== configuration.organizationId ||
      claims.binding_version !== configuration.bindingVersion ||
      claims.installation_key !== configuration.keyFingerprint ||
      typeof claims.sub !== "string" ||
      !claims.sub.trim() ||
      claims.sub.length > 200 ||
      typeof claims.workspace_id !== "string" ||
      typeof claims.membership_version !== "string" ||
      claims.email_verified !== true ||
      typeof claims.email !== "string" ||
      !claims.email.includes("@") ||
      claims.email.length > 320 ||
      typeof claims.name !== "string" ||
      claims.name.length > 200
    )
      throw refused();
    let personalDevice: NativeLoginIdentity["personalDevice"];
    if (claims.personal_device !== undefined) {
      const raw = claims.personal_device as {
        id?: unknown;
        public_key?: unknown;
        registry_version?: unknown;
      } | null;
      const parsed = personalDeviceSchema.safeParse({ id: raw?.id, publicKey: raw?.public_key });
      if (
        claims.organization_type !== "personal" ||
        !parsed.success ||
        !Number.isSafeInteger(raw?.registry_version) ||
        Number(raw?.registry_version) <= 0 ||
        !personalDeviceKey(parsed.data.publicKey) ||
        !personalDeviceSignature(
          parsed.data.publicKey,
          personalActivationMessage(
            { ...configuration, workspaceId: claims.workspace_id, deviceId: parsed.data.id },
            challenge,
            createHash("sha256").update(grant).digest("hex"),
          ),
          deviceSignature,
        )
      )
        throw refused();
      personalDevice = { ...parsed.data, registryVersion: raw!.registry_version as number };
    }
    const workspace = this.window.workspace(claims.workspace_id);
    const member = workspace?.members.find(
      (value) => value.userId === claims.sub && value.accessVersion === claims.membership_version,
    );
    if (
      !workspace ||
      !member ||
      claims.permission_version !== workspace.permissionVersion ||
      claims.workspace_role !== member.role ||
      !this.window.permits(workspace.id, claims.sub, member.accessVersion)
    )
      throw refused();
    const binding = await runAsSystem(
      "resolve a signed login to its explicit local workspace",
      () => this.prisma.centralWorkspaceBinding.findUnique({ where: { id: workspace.id } }),
    );
    if (
      binding?.state !== "ready" ||
      binding.spaceId !== workspace.localWorkspaceId ||
      binding.localOrganizationId !== workspace.localOrganizationId ||
      binding.permissionVersion !== workspace.permissionVersion ||
      binding.validUntil.getTime() <= Date.now()
    )
      throw refused();
    return {
      issuer: this.issuer,
      subject: claims.sub,
      ...(personalDevice ? { personalDevice } : {}),
      allowProvision: true,
      email: claims.email,
      name: claims.name,
      jwtId: claims.jti!,
      expiresAt: claims.exp!,
      centralWorkspace: {
        id: workspace.id,
        spaceId: binding.spaceId,
        organizationId: binding.localOrganizationId,
        revision: member.accessVersion,
        role: member.role,
      },
    };
  }

  async provisionMember(userId: string, identity: NativeLoginIdentity): Promise<void> {
    const workspace = identity.centralWorkspace;
    if (!workspace || identity.issuer !== this.issuer) throw refused();
    if (!this.window.permits(workspace.id, identity.subject, workspace.revision)) {
      const device =
        identity.personalDevice &&
        (await this.personal.find(
          workspace.id,
          userId,
          workspace.revision,
          identity.personalDevice.id,
        ));
      if (
        !device ||
        device.centralSubject !== identity.subject ||
        device.publicKey !== identity.personalDevice?.publicKey
      )
        throw refused();
      return;
    }
    await runAsSystem("provision only the workspace named by a verified login", () =>
      this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM central_workspace_bindings WHERE id = ${workspace.id} FOR UPDATE`;
        const binding = await tx.centralWorkspaceBinding.findUniqueOrThrow({
          where: { id: workspace.id },
        });
        const members = workspaceProjectionSchema.shape.workspaces.element.shape.members.parse(
          binding.members,
        );
        if (
          binding.state !== "ready" ||
          binding.spaceId !== workspace.spaceId ||
          binding.localOrganizationId !== workspace.organizationId ||
          binding.validUntil.getTime() <= Date.now() ||
          !members.some(
            (member) =>
              member.userId === identity.subject &&
              member.accessVersion === workspace.revision &&
              member.role === workspace.role,
          )
        )
          throw refused();
        await tx.member.upsert({
          where: { organizationId_userId: { organizationId: workspace.organizationId, userId } },
          create: {
            id: randomUUID(),
            organizationId: workspace.organizationId,
            userId,
            role: "member",
            createdAt: new Date(),
          },
          update: { role: "member" },
        });
        await tx.spaceMember.upsert({
          where: { spaceId_userId: { spaceId: workspace.spaceId, userId } },
          create: {
            id: randomUUID(),
            spaceId: workspace.spaceId,
            organizationId: workspace.organizationId,
            userId,
            role: workspace.role,
            createdAt: new Date(),
          },
          update: { role: workspace.role },
        });
        await tx.centralWorkspaceAccess.upsert({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
          create: {
            workspaceId: workspace.id,
            userId,
            centralSubject: identity.subject,
            role: workspace.role,
            membershipVersion: workspace.revision,
            active: true,
          },
          update: {
            centralSubject: identity.subject,
            role: workspace.role,
            membershipVersion: workspace.revision,
            active: true,
          },
        });
      }),
    );
  }

  async bindSession(
    sessionId: string,
    userId: string,
    identity: NativeLoginIdentity,
  ): Promise<void> {
    if (!identity.centralWorkspace) throw refused();
    await this.provisionMember(userId, identity);
    await runAsSystem("bind a newly authenticated session to its verified workspace", async () => {
      const session = await this.prisma.session.findFirst({
        where: { id: sessionId, userId, expiresAt: { gt: new Date() } },
        select: { id: true },
      });
      if (!session) throw refused();
      const device = identity.personalDevice
        ? await this.personal.device(identity.personalDevice.id)
        : null;
      if (
        device &&
        (device.userId !== userId ||
          device.centralSubject !== identity.subject ||
          device.workspaceId !== identity.centralWorkspace!.id ||
          device.publicKey !== identity.personalDevice?.publicKey)
      )
        throw refused();
      await this.prisma.centralSessionBinding.create({
        data: {
          sessionId,
          personalDeviceId: device?.id ?? null,
          workspaceId: identity.centralWorkspace!.id,
          centralSubject: identity.subject,
          membershipVersion: identity.centralWorkspace!.revision,
        },
      });
    });
  }

  async personalChallenge(deviceId: string, challenge: string) {
    const device = await this.personal.device(deviceId);
    if (!device) throw refused();
    const target = await this.personal.target(device);
    return { target, ...(await this.installation.provePersonalDeviceChallenge(target, challenge)) };
  }

  async personalIdentity(
    deviceId: string,
  ): Promise<{ userId: string; identity: NativeLoginIdentity } | null> {
    const device = await this.personal.device(deviceId);
    if (!device) return null;
    return runAsSystem(
      "resolve the exact personal identity already activated on this device",
      async () => {
        const binding = await this.prisma.centralWorkspaceBinding.findUnique({
          where: { id: device.workspaceId },
        });
        const account = await this.prisma.account.findFirst({
          where: {
            userId: device.userId,
            providerId: "oidc",
            accountId: oidcAccountSubject(this.issuer, device.centralSubject),
          },
        });
        const access = await this.prisma.centralWorkspaceAccess.findUnique({
          where: { workspaceId_userId: { workspaceId: device.workspaceId, userId: device.userId } },
        });
        if (!binding || !account || !access?.active) return null;
        return {
          userId: device.userId,
          identity: {
            issuer: this.issuer,
            subject: device.centralSubject,
            personalDevice: {
              id: device.id,
              publicKey: device.publicKey,
              registryVersion: device.registryVersion,
            },
            centralWorkspace: {
              id: binding.id,
              spaceId: binding.spaceId,
              organizationId: binding.localOrganizationId,
              revision: device.membershipVersion,
              role: access.role as "admin" | "member",
            },
          },
        };
      },
    );
  }

  async session(
    sessionId: string,
    userId: string,
    requestedSpaceId?: string | null,
  ): Promise<{
    spaceId: string;
    subject: string;
    revision: string;
    workspaceId: string;
    personalDeviceId: string | null;
  } | null> {
    return runAsSystem("verify the exact workspace of a native session", async () => {
      const session = await this.prisma.centralSessionBinding.findUnique({
        where: { sessionId },
        include: { workspace: true, session: { select: { userId: true } } },
      });
      if (
        !session ||
        session.session.userId !== userId ||
        (requestedSpaceId && requestedSpaceId !== session.workspace.spaceId)
      )
        return null;
      const access = await this.prisma.centralWorkspaceAccess.findUnique({
        where: { workspaceId_userId: { workspaceId: session.workspaceId, userId } },
      });
      if (
        !access?.active ||
        access.centralSubject !== session.centralSubject ||
        access.membershipVersion !== session.membershipVersion ||
        session.workspace.state !== "ready"
      )
        return null;
      if (session.personalDeviceId) {
        const device = await this.personal.find(
          session.workspaceId,
          userId,
          session.membershipVersion,
          session.personalDeviceId,
        );
        if (!device || device.centralSubject !== session.centralSubject) return null;
      } else if (
        !this.window.permits(
          session.workspaceId,
          session.centralSubject,
          session.membershipVersion,
        ) ||
        session.workspace.validUntil.getTime() <= Date.now()
      )
        return null;
      return {
        spaceId: session.workspace.spaceId,
        subject: session.centralSubject,
        revision: session.membershipVersion,
        workspaceId: session.workspaceId,
        personalDeviceId: session.personalDeviceId,
      };
    });
  }

  async watchSession(scope: {
    workspaceId: string;
    subject: string;
    revision: string;
    personalDeviceId?: string | null;
  }): Promise<{ signal: AbortSignal; dispose(): void }> {
    if (scope.personalDeviceId) {
      const device = await this.personal.device(scope.personalDeviceId);
      if (
        device &&
        device.workspaceId === scope.workspaceId &&
        device.centralSubject === scope.subject &&
        device.membershipVersion === scope.revision
      )
        return this.personal.watch(device);
      return { signal: AbortSignal.abort(refused()), dispose() {} };
    }
    return this.window.watch(scope.workspaceId, scope.subject, scope.revision);
  }

  invalidate(workspaceId: string): void {
    this.window.invalidate(workspaceId);
    this.personal.invalidate(workspaceId);
  }

  async work(
    spaceId: string,
    userId: string,
    expectedRevision?: string,
    expectedWorkspaceId?: string,
    personalDeviceId?: string | null,
  ): Promise<{ signal: AbortSignal; dispose: () => void } | null> {
    const access = await runAsSystem(
      "check central admission immediately before workspace execution",
      () =>
        this.prisma.centralWorkspaceAccess.findFirst({
          where: {
            userId,
            active: true,
            workspace: { spaceId, state: "ready" },
          },
        }),
    );
    if (
      !access ||
      !expectedRevision ||
      access.membershipVersion !== expectedRevision ||
      (expectedWorkspaceId && access.workspaceId !== expectedWorkspaceId)
    )
      return null;
    const device =
      personalDeviceId === null
        ? null
        : await this.personal.find(
            access.workspaceId,
            userId,
            access.membershipVersion,
            personalDeviceId,
          );
    if (personalDeviceId && !device) return null;
    if (device) return this.personal.watch(device);
    if (!this.window.permits(access.workspaceId, access.centralSubject, access.membershipVersion))
      return null;
    const binding = await runAsSystem("check workspace expiry before execution", () =>
      this.prisma.centralWorkspaceBinding.findUnique({ where: { id: access.workspaceId } }),
    );
    if (!binding || binding.validUntil.getTime() <= Date.now()) return null;
    return this.window.watch(access.workspaceId, access.centralSubject, access.membershipVersion);
  }

  async execution(scope: {
    spaceId: string;
    userId: string;
    workspaceId?: string | null;
    membershipVersion?: string | null;
    personalDeviceId?: string | null;
  }): Promise<{ signal: AbortSignal; dispose(): void } | null | undefined> {
    if (!(await this.installation.registered())) return undefined;
    if (!scope.workspaceId || !scope.membershipVersion) return null;
    return this.work(
      scope.spaceId,
      scope.userId,
      scope.membershipVersion,
      scope.workspaceId,
      scope.personalDeviceId ?? null,
    );
  }

  dispose(): void {
    this.window.dispose();
    this.personal.dispose();
  }
}
