// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { PersonalDevice, PersonalDeviceTarget, WorkspaceProjection } from "@orkbot/contracts";
import type { PersonalWorkspaceDevice, PrismaClient } from "@orkbot/db";
import { runAsSystem } from "@orkbot/db";
import type { InstallationClient } from "./installation-client.js";
import type { NativeLoginIdentity } from "./native-accounts-login.js";
import type { PersonalRevocations } from "./personal-revocations.js";

const denied = () => new Error("Personal device access unavailable");
/** Durable personal authority is separate from the expiring corporate projection cache. */
export class PersonalWorkspaceAccess {
  private readonly blocked = new Set<string>();
  private blockEverything = false;
  private refusalBarrier?: Promise<void>;
  private readonly watches = new Map<string, Set<AbortController>>();
  constructor(
    private readonly prisma: PrismaClient,
    private readonly installation: InstallationClient,
    private readonly revocations?: PersonalRevocations,
  ) {}

  async activate(
    sessionId: string,
    userId: string,
    identity: NativeLoginIdentity,
    device: PersonalDevice,
  ): Promise<PersonalWorkspaceDevice> {
    const workspace = identity.centralWorkspace;
    const configuration = await this.installation.configuration();
    if (
      !this.revocations ||
      (await this.revocations.restorationCheckpoint()).length > 0 ||
      (await this.revocations.revoked(device.id)) ||
      !workspace ||
      !configuration ||
      identity.personalDevice?.id !== device.id ||
      identity.personalDevice.publicKey !== device.publicKey
    )
      throw denied();
    return runAsSystem("activate an explicitly proven personal device", () =>
      this.prisma.$transaction(async (tx) => {
        const binding = await tx.centralWorkspaceBinding.findUniqueOrThrow({
          where: { id: workspace.id },
        });
        const access = await tx.centralWorkspaceAccess.findUniqueOrThrow({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
        });
        if (
          binding.state !== "ready" ||
          binding.validUntil.getTime() <= Date.now() ||
          !access.active ||
          access.centralSubject !== identity.subject ||
          access.membershipVersion !== workspace.revision ||
          binding.serverId !== configuration.serverId ||
          binding.centralOrganizationId !== configuration.organizationId ||
          binding.bindingVersion !== configuration.bindingVersion
        )
          throw denied();
        // Reusing a device ID cannot restore a revoked credential or silently replace its key.
        const row = await tx.personalWorkspaceDevice.upsert({
          where: { id: device.id },
          update: {},
          create: {
            id: device.id,
            workspaceId: workspace.id,
            userId,
            centralSubject: identity.subject,
            membershipVersion: workspace.revision,
            permissionVersion: binding.permissionVersion,
            registryVersion: identity.personalDevice!.registryVersion,
            bindingVersion: configuration.bindingVersion,
            keyFingerprint: configuration.keyFingerprint,
            publicKey: device.publicKey,
          },
        });
        if (
          row.revokedAt ||
          row.workspaceId !== workspace.id ||
          row.userId !== userId ||
          row.centralSubject !== identity.subject ||
          row.membershipVersion !== workspace.revision ||
          row.permissionVersion !== binding.permissionVersion ||
          row.registryVersion !== identity.personalDevice!.registryVersion ||
          row.bindingVersion !== configuration.bindingVersion ||
          row.keyFingerprint !== configuration.keyFingerprint ||
          row.publicKey !== device.publicKey
        )
          throw denied();
        const bound = await tx.centralSessionBinding.updateMany({
          where: {
            sessionId,
            workspaceId: workspace.id,
            centralSubject: identity.subject,
            membershipVersion: workspace.revision,
            session: { userId },
          },
          data: { personalDeviceId: row.id },
        });
        if (bound.count !== 1) throw denied();
        return row;
      }),
    );
  }

  async device(id: string): Promise<PersonalWorkspaceDevice | null> {
    return runAsSystem("verify a personal device against its retained admission", async () => {
      const device = await this.prisma.personalWorkspaceDevice.findUnique({ where: { id } });
      if (
        !this.revocations ||
        (await this.revocations.restorationCheckpoint()).length > 0 ||
        (await this.revocations.revoked(id)) ||
        !device ||
        device.revokedAt ||
        this.blockEverything ||
        this.blocked.has(device.workspaceId)
      )
        return null;
      const allowed = await this.prisma.$queryRaw<
        Array<{ allowed: boolean }>
      >`SELECT app_personal_workspace_access(${device.workspaceId}, ${device.userId}) AS allowed`;
      if (!allowed[0]?.allowed) return null;
      const binding = await this.prisma.centralWorkspaceBinding.findUnique({
        where: { id: device.workspaceId },
      });
      const access = await this.prisma.centralWorkspaceAccess.findUnique({
        where: { workspaceId_userId: { workspaceId: device.workspaceId, userId: device.userId } },
      });
      if (
        !binding ||
        !access?.active ||
        access.centralSubject !== device.centralSubject ||
        access.membershipVersion !== device.membershipVersion ||
        binding.permissionVersion !== device.permissionVersion ||
        binding.bindingVersion !== device.bindingVersion
      )
        return null;
      const configuration = await this.installation.configuration();
      return configuration?.keyFingerprint === device.keyFingerprint &&
        configuration.bindingVersion === device.bindingVersion &&
        configuration.serverId === binding.serverId &&
        configuration.organizationId === binding.centralOrganizationId
        ? device
        : null;
    });
  }

  async find(
    workspaceId: string,
    userId: string,
    revision: string,
    deviceId?: string,
  ): Promise<PersonalWorkspaceDevice | null> {
    if (this.blockEverything || this.blocked.has(workspaceId)) return null;
    const rows = await runAsSystem("resolve personal authority for a workspace operation", () =>
      this.prisma.personalWorkspaceDevice.findMany({
        where: {
          ...(deviceId ? { id: deviceId } : {}),
          workspaceId,
          userId,
          membershipVersion: revision,
          revokedAt: null,
        },
        select: { id: true },
      }),
    );
    for (const row of rows) {
      const device = await this.device(row.id);
      if (device) return device;
    }
    return null;
  }

  async target(device: PersonalWorkspaceDevice): Promise<PersonalDeviceTarget> {
    const configuration = await this.installation.configuration();
    if (
      !configuration ||
      device.bindingVersion !== configuration.bindingVersion ||
      device.keyFingerprint !== configuration.keyFingerprint
    )
      throw denied();
    return { ...configuration, workspaceId: device.workspaceId, deviceId: device.id };
  }

  async watch(device: PersonalWorkspaceDevice): Promise<{ signal: AbortSignal; dispose(): void }> {
    const controller = new AbortController();
    const set = this.watches.get(device.workspaceId) ?? new Set<AbortController>();
    set.add(controller);
    this.watches.set(device.workspaceId, set);
    let checking = false;
    const check = async () => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        if (!(await this.device(device.id))) controller.abort(denied());
      } catch {
        controller.abort(denied());
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => {
      void check();
    }, 1000);
    timer.unref?.();
    const dispose = () => {
      clearInterval(timer);
      set.delete(controller);
      if (!set.size) this.watches.delete(device.workspaceId);
    };
    controller.signal.addEventListener("abort", dispose, { once: true });
    await check();
    return { signal: controller.signal, dispose };
  }

  async restrict(projection: WorkspaceProjection): Promise<void> {
    const devices = await runAsSystem(
      "compare durable personal admissions with a received projection",
      () => this.prisma.personalWorkspaceDevice.findMany({ where: { revokedAt: null } }),
    );
    const revoked = devices.filter((device) => {
      const workspace = projection.workspaces.find((value) => value.id === device.workspaceId);
      return (
        projection.bindingVersion !== device.bindingVersion ||
        projection.keyFingerprint !== device.keyFingerprint ||
        !workspace ||
        workspace.state !== "ready" ||
        workspace.permissionVersion !== device.permissionVersion ||
        !workspace.members.some(
          (member) =>
            member.userId === device.centralSubject &&
            member.accessVersion === device.membershipVersion,
        ) ||
        workspace.personalDeviceVersion === undefined ||
        !workspace.personalDevices ||
        (workspace.personalDeviceVersion >= device.registryVersion &&
          !workspace.personalDevices.includes(device.id))
      );
    });
    if (!revoked.length) return;
    for (const device of revoked) this.invalidate(device.workspaceId);
    await this.revocations?.revoke(revoked.map((device) => device.id));
    await runAsSystem("persist personal revocations before updating the projection", () =>
      this.prisma.personalWorkspaceDevice.updateMany({
        where: { id: { in: revoked.map((device) => device.id) } },
        data: { revokedAt: new Date() },
      }),
    );
  }

  invalidate(workspaceId: string): void {
    this.blocked.add(workspaceId);
    for (const controller of this.watches.get(workspaceId) ?? []) controller.abort(denied());
  }
  confirmed(workspaceIds: string[]): void {
    this.blockEverything = false;
    this.refusalBarrier = undefined;
    for (const id of workspaceIds) this.blocked.delete(id);
  }
  restorationCheckpoint(): Promise<string[]> {
    return this.revocations?.restorationCheckpoint() ?? Promise.resolve([]);
  }
  async confirmRestoration(checkpoint: readonly string[]): Promise<void> {
    await this.revocations?.confirmRestoration(checkpoint);
  }
  async refuseInstallation(): Promise<void> {
    this.blockEverything = true;
    for (const id of this.watches.keys()) this.invalidate(id);
    try {
      this.refusalBarrier ??= this.revocations?.refuseInstallation() ?? Promise.resolve();
      await this.refusalBarrier;
    } catch (error) {
      this.refusalBarrier = undefined;
      throw error;
    }
    const devices = await runAsSystem(
      "resolve personal credentials for installation revocation",
      () =>
        this.prisma.personalWorkspaceDevice.findMany({
          where: { revokedAt: null },
          select: { id: true },
        }),
    );
    await this.revocations?.revoke(devices.map((device) => device.id));
    await runAsSystem("persist known installation revocation for personal credentials", () =>
      this.prisma.personalWorkspaceDevice.updateMany({
        where: { revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }
  async logout(sessionId: string): Promise<void> {
    const binding = await runAsSystem("resolve the personal device being signed out", () =>
      this.prisma.centralSessionBinding.findUnique({ where: { sessionId } }),
    );
    if (!binding?.personalDeviceId) return;
    this.invalidate(binding.workspaceId);
    const deviceId = binding.personalDeviceId;
    await this.revocations?.revoke([deviceId]);
    await runAsSystem("revoke a personal credential before logout removes its session", () =>
      this.prisma.personalWorkspaceDevice.updateMany({
        where: { id: deviceId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
    // Other devices can continue after their own fresh database validation.
    this.blocked.delete(binding.workspaceId);
  }
  dispose(): void {
    this.blockEverything = true;
    for (const id of this.watches.keys()) this.invalidate(id);
  }
}
