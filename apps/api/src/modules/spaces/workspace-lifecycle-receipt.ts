// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { InstallationConfiguration } from "@orkbot/auth/installation-client";
import type { WorkspaceLifecycleOperation } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { lockOrganizationSpaces, runAsSystem } from "@orkbot/db";

const CLAIM_MS = 5 * 60_000;

export class WorkspaceExternalMemoryError extends Error {
  constructor() {
    super("Workspace deletion cannot yet remove configured external memory");
  }
}

/** Persist the exact local scope before teardown. The receipt intentionally has no
 * foreign key to the workspace, so a lost acknowledgement remains retryable. */
export async function claimWorkspaceLifecycleReceipt(
  prisma: PrismaClient,
  configuration: InstallationConfiguration,
  operation: WorkspaceLifecycleOperation,
) {
  if (operation.kind !== "delete" || !operation.localOrganizationId || !operation.localWorkspaceId)
    throw new Error("Invalid workspace deletion operation");
  const localOrganizationId = operation.localOrganizationId;
  const rootSpaceId = operation.localWorkspaceId;
  return runAsSystem("claim a verified workspace deletion", () =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM installation_identity WHERE id = 'local' FOR UPDATE`;
      const identity = await tx.installationIdentity.findUnique({ where: { id: "local" } });
      if (
        !identity ||
        identity.state !== "ready" ||
        identity.serverId !== configuration.serverId ||
        identity.centralOrganizationId !== configuration.organizationId ||
        identity.bindingVersion !== configuration.bindingVersion ||
        identity.keyFingerprint !== configuration.keyFingerprint
      )
        throw new Error("Installation binding changed");
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workspace-lifecycle:${operation.operationId}`}, 0))::text`;
      let receipt = await tx.workspaceLifecycleReceipt.findUnique({
        where: { operationId: operation.operationId },
      });
      if (!receipt) {
        await lockOrganizationSpaces(tx, localOrganizationId);
        const binding = await tx.centralWorkspaceBinding.findUnique({
          where: { id: operation.workspaceId },
        });
        if (
          !binding ||
          binding.serverId !== configuration.serverId ||
          binding.centralOrganizationId !== configuration.organizationId ||
          binding.bindingVersion !== configuration.bindingVersion ||
          binding.permissionVersion !== operation.permissionVersion ||
          binding.state !== "disabled" ||
          binding.validUntil <= new Date() ||
          binding.localOrganizationId !== localOrganizationId ||
          binding.spaceId !== rootSpaceId
        )
          throw new Error("Workspace lifecycle binding is unavailable or changed");
        const spaces = await tx.space.findMany({
          where: {
            organizationId: localOrganizationId,
            OR: [
              { id: rootSpaceId },
              { admissionWorkspaceId: operation.workspaceId, centralBinding: null },
            ],
          },
          select: { id: true },
          orderBy: { id: "asc" },
        });
        const spaceIds = spaces.map((space) => space.id);
        if (!spaceIds.includes(rootSpaceId))
          throw new Error("Workspace lifecycle root is unavailable");
        receipt = await tx.workspaceLifecycleReceipt.create({
          data: {
            operationId: operation.operationId,
            workspaceId: operation.workspaceId,
            serverId: configuration.serverId,
            centralOrganizationId: configuration.organizationId,
            keyFingerprint: configuration.keyFingerprint,
            bindingVersion: configuration.bindingVersion,
            permissionVersion: operation.permissionVersion,
            kind: operation.kind,
            localOrganizationId,
            rootSpaceId,
            spaceIds,
          },
        });
      }
      if (
        receipt.workspaceId !== operation.workspaceId ||
        receipt.serverId !== configuration.serverId ||
        receipt.centralOrganizationId !== configuration.organizationId ||
        receipt.keyFingerprint !== configuration.keyFingerprint ||
        receipt.bindingVersion !== configuration.bindingVersion ||
        receipt.permissionVersion !== operation.permissionVersion ||
        receipt.kind !== operation.kind ||
        receipt.localOrganizationId !== localOrganizationId ||
        receipt.rootSpaceId !== rootSpaceId ||
        !Array.isArray(receipt.spaceIds) ||
        receipt.spaceIds.length === 0 ||
        receipt.spaceIds.some((id) => typeof id !== "string" || !id || id.length > 200) ||
        !receipt.spaceIds.includes(rootSpaceId) ||
        new Set(receipt.spaceIds).size !== receipt.spaceIds.length
      )
        throw new Error("Workspace lifecycle receipt does not match the operation");
      const spaceIds = receipt.spaceIds as string[];
      if (receipt.state === "complete") return { complete: true as const, spaceIds };
      if (receipt.state !== "pending") throw new Error("Invalid workspace lifecycle receipt");
      // The optional semantic-memory adapters cannot yet prove that all remotely stored
      // workspace facts were erased. Keep their configuration and credentials until
      // that provider supports a complete, scoped purge.
      if (await tx.spaceMemoryConfig.count({ where: { spaceId: { in: spaceIds } } }))
        throw new WorkspaceExternalMemoryError();
      const now = new Date();
      const claimId = randomUUID();
      const claimed = await tx.workspaceLifecycleReceipt.updateMany({
        where: {
          operationId: operation.operationId,
          state: "pending",
          OR: [{ claimUntil: null }, { claimUntil: { lte: now } }],
        },
        data: { claimId, claimUntil: new Date(now.getTime() + CLAIM_MS) },
      });
      if (claimed.count !== 1) return null;
      return { complete: false as const, claimId, spaceIds };
    }),
  );
}

/** Never renew a claim after its lease expired or another process took it over. */
export async function renewWorkspaceLifecycleReceipt(
  prisma: PrismaClient,
  operationId: string,
  claimId: string,
) {
  const now = new Date();
  const updated = await runAsSystem("renew workspace deletion lease", () =>
    prisma.workspaceLifecycleReceipt.updateMany({
      where: { operationId, claimId, state: "pending", claimUntil: { gt: now } },
      data: { claimUntil: new Date(now.getTime() + CLAIM_MS) },
    }),
  );
  return updated.count === 1;
}

/** Complete only when the entire recorded scope and its central binding are gone. */
export async function completeWorkspaceLifecycleReceipt(
  prisma: PrismaClient,
  operationId: string,
  claimId: string,
) {
  return runAsSystem("complete a managed workspace deletion", () =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM installation_identity WHERE id = 'local' FOR UPDATE`;
      const receipt = await tx.workspaceLifecycleReceipt.findUnique({ where: { operationId } });
      const identity = await tx.installationIdentity.findUnique({ where: { id: "local" } });
      if (
        !receipt ||
        receipt.state !== "pending" ||
        receipt.claimId !== claimId ||
        !receipt.claimUntil ||
        receipt.claimUntil <= new Date() ||
        !Array.isArray(receipt.spaceIds) ||
        receipt.spaceIds.some((id) => typeof id !== "string") ||
        !identity ||
        identity.state !== "ready" ||
        identity.serverId !== receipt.serverId ||
        identity.centralOrganizationId !== receipt.centralOrganizationId ||
        identity.bindingVersion !== receipt.bindingVersion ||
        identity.keyFingerprint !== receipt.keyFingerprint
      )
        throw new Error("Workspace deletion claim expired");
      await lockOrganizationSpaces(tx, receipt.localOrganizationId);
      const [remaining, descendants, binding] = await Promise.all([
        tx.space.count({ where: { id: { in: receipt.spaceIds as string[] } } }),
        tx.space.count({
          where: {
            organizationId: receipt.localOrganizationId,
            admissionWorkspaceId: receipt.workspaceId,
          },
        }),
        tx.centralWorkspaceBinding.findUnique({
          where: { id: receipt.workspaceId },
          select: { id: true },
        }),
      ]);
      if (remaining || descendants || binding) throw new Error("Workspace deletion is incomplete");
      const done = await tx.workspaceLifecycleReceipt.updateMany({
        where: { operationId, state: "pending", claimId, claimUntil: { gt: new Date() } },
        data: { state: "complete", claimId: null, claimUntil: null },
      });
      if (done.count !== 1) throw new Error("Workspace deletion claim expired");
    }),
  );
}
