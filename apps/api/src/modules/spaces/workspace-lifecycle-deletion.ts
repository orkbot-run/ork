// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Prisma, PrismaClient } from "@orkbot/db";
import { deletePageShareSecrets, lockOrganizationSpaces, runAsSystem } from "@orkbot/db";

export type ManagedSpaceClaim = { operationId: string; claimId: string; spaceId: string };

async function validateClaim(tx: Prisma.TransactionClient, input: ManagedSpaceClaim) {
  await tx.$queryRaw`SELECT "operationId" FROM workspace_lifecycle_receipts WHERE "operationId" = ${input.operationId} FOR UPDATE`;
  const receipt = await tx.workspaceLifecycleReceipt.findUnique({
    where: { operationId: input.operationId },
  });
  if (
    !receipt ||
    receipt.kind !== "delete" ||
    receipt.state !== "pending" ||
    receipt.claimId !== input.claimId ||
    !receipt.claimUntil ||
    receipt.claimUntil <= new Date() ||
    !Array.isArray(receipt.spaceIds) ||
    !receipt.spaceIds.includes(input.spaceId)
  )
    throw new Error("Workspace deletion claim expired");
  const identity = await tx.installationIdentity.findUnique({ where: { id: "local" } });
  if (
    !identity ||
    identity.state !== "ready" ||
    identity.serverId !== receipt.serverId ||
    identity.centralOrganizationId !== receipt.centralOrganizationId ||
    identity.bindingVersion !== receipt.bindingVersion ||
    identity.keyFingerprint !== receipt.keyFingerprint
  )
    throw new Error("Installation binding changed");
  return receipt;
}

/** Claim only a Space explicitly recorded under the signed operation. */
export async function claimManagedSpace(prisma: PrismaClient, input: ManagedSpaceClaim) {
  return runAsSystem("claim a managed workspace space", () =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM installation_identity WHERE id = 'local' FOR UPDATE`;
      const receipt = await validateClaim(tx, input);
      await lockOrganizationSpaces(tx, receipt.localOrganizationId);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.spaceId}, 0))::text`;
      const space = await tx.space.findUnique({
        where: { id: input.spaceId },
        select: {
          id: true,
          organizationId: true,
          admissionWorkspaceId: true,
          centralBinding: { select: { id: true } },
          deletionClaimId: true,
          deletingAt: true,
        },
      });
      if (!space) return { missing: true as const, recovered: false };
      if (
        space.organizationId !== receipt.localOrganizationId ||
        (input.spaceId !== receipt.rootSpaceId &&
          (space.admissionWorkspaceId !== receipt.workspaceId || space.centralBinding !== null))
      )
        throw new Error("Workspace space ownership changed");
      const binding = await tx.centralWorkspaceBinding.findUnique({
        where: { id: receipt.workspaceId },
      });
      if (
        !binding ||
        binding.spaceId !== receipt.rootSpaceId ||
        binding.state !== "disabled" ||
        binding.serverId !== receipt.serverId ||
        binding.bindingVersion !== receipt.bindingVersion ||
        binding.permissionVersion !== receipt.permissionVersion
      )
        throw new Error("Workspace lifecycle binding is unavailable or changed");
      const stale = new Date(Date.now() - 5 * 60_000);
      const claimed = await tx.space.updateMany({
        where: {
          id: input.spaceId,
          OR: [
            { deletingAt: null },
            { deletionClaimId: input.claimId },
            { deletingAt: { lt: stale } },
          ],
        },
        data: { deletingAt: new Date(), deletionClaimId: input.claimId },
      });
      if (claimed.count !== 1) throw new Error("Workspace space deletion is already in progress");
      if (
        !Array.isArray(receipt.homeKeys) ||
        !Array.isArray(receipt.homeStorageIds) ||
        receipt.homeKeys.some((key) => typeof key !== "string") ||
        receipt.homeStorageIds.some((id) => typeof id !== "string")
      )
        throw new Error("Workspace cleanup manifest is invalid");
      const homes = await tx.computer.findMany({
        where: { spaceId: input.spaceId },
        select: { homeKey: true, homeStorageId: true },
      });
      await tx.workspaceLifecycleReceipt.update({
        where: { operationId: input.operationId },
        data: {
          homeKeys: [
            ...new Set([...(receipt.homeKeys as string[]), ...homes.map((home) => home.homeKey)]),
          ],
          homeStorageIds: [
            ...new Set([
              ...(receipt.homeStorageIds as string[]),
              ...homes.flatMap((home) => (home.homeStorageId ? [home.homeStorageId] : [])),
            ]),
          ],
        },
      });
      return { missing: false as const, recovered: Boolean(space.deletingAt) };
    }),
  );
}

export async function renewManagedSpace(prisma: PrismaClient, input: ManagedSpaceClaim) {
  return runAsSystem("renew a managed workspace space claim", () =>
    prisma.$transaction(async (tx) => {
      await validateClaim(tx, input);
      const result = await tx.space.updateMany({
        where: { id: input.spaceId, deletionClaimId: input.claimId },
        data: { deletingAt: new Date() },
      });
      return result.count === 1;
    }),
  );
}

/** Remove the root binding only after every descendant and external handle is gone. */
export async function deleteClaimedManagedSpace(prisma: PrismaClient, input: ManagedSpaceClaim) {
  return runAsSystem("delete a claimed managed workspace space", () =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM installation_identity WHERE id = 'local' FOR UPDATE`;
      const receipt = await validateClaim(tx, input);
      await lockOrganizationSpaces(tx, receipt.localOrganizationId);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.spaceId}, 0))::text`;
      const space = await tx.space.findFirst({
        where: {
          id: input.spaceId,
          organizationId: receipt.localOrganizationId,
          deletionClaimId: input.claimId,
        },
      });
      if (
        !space ||
        (input.spaceId !== receipt.rootSpaceId &&
          space.admissionWorkspaceId !== receipt.workspaceId)
      )
        throw new Error("Workspace deletion claim changed");
      const [bots, computers, artifacts, homes] = await Promise.all([
        tx.bot.count({ where: { spaceId: input.spaceId } }),
        tx.computer.count({ where: { spaceId: input.spaceId, providerRef: { not: null } } }),
        tx.artifact.findMany({ where: { spaceId: input.spaceId }, select: { storageKey: true } }),
        tx.computer.findMany({ where: { spaceId: input.spaceId }, select: { homeKey: true } }),
      ]);
      if (bots || computers) throw new Error("Workspace teardown is incomplete");
      if (input.spaceId === receipt.rootSpaceId) {
        const children = await tx.space.count({
          where: {
            organizationId: receipt.localOrganizationId,
            admissionWorkspaceId: receipt.workspaceId,
          },
        });
        if (children) throw new Error("Workspace spaces still remain");
        const removed = await tx.centralWorkspaceBinding.deleteMany({
          where: {
            id: receipt.workspaceId,
            spaceId: receipt.rootSpaceId,
            state: "disabled",
            serverId: receipt.serverId,
            bindingVersion: receipt.bindingVersion,
            permissionVersion: receipt.permissionVersion,
          },
        });
        if (removed.count !== 1) throw new Error("Workspace lifecycle binding changed");
      }
      const pageShareSecrets = await deletePageShareSecrets(tx, { spaceId: input.spaceId });
      await tx.space.delete({ where: { id: input.spaceId } });
      return {
        id: receipt.rootSpaceId,
        artifactKeys: artifacts.map((item) => item.storageKey),
        homeKeys: homes.map((item) => item.homeKey),
        pageShareSecrets,
      };
    }),
  );
}
