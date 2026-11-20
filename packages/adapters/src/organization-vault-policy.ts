// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { PrismaClient } from "@orkbot/db";
import { currentDbContext, runAsSystem, workspaceAdmissionBinding } from "@orkbot/db";

export type VaultActor = { userId: string; spaceId: string };

/** Resolve from the signed Accounts admission, never from a client-provided organization type. */
export async function organizationVaultPolicy(prisma: PrismaClient, actor: VaultActor) {
  const context = currentDbContext();
  if (
    context?.kind === "tenant" &&
    (context.userId !== actor.userId || context.spaceId !== actor.spaceId)
  )
    throw new Error("Workspace access denied");
  return runAsSystem("resolve the organization's vault policy", async () => {
    const binding = await workspaceAdmissionBinding(prisma, actor.spaceId);
    if (!binding) return { kind: "unmanaged" as const };
    if (binding.organizationType === "personal") return { kind: "personal" as const };
    // An older, unverifiable binding must never expose a member's personal vault.
    if (binding.organizationType !== "shared") return { kind: "unverified" as const };
    const [installation, access, spaceMember] = await Promise.all([
      prisma.installationIdentity.findUnique({ where: { id: "local" } }),
      prisma.centralWorkspaceAccess.findUnique({
        where: { workspaceId_userId: { workspaceId: binding.id, userId: actor.userId } },
      }),
      binding.spaceId === actor.spaceId
        ? Promise.resolve(true)
        : prisma.spaceMember.findUnique({
            where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
            select: { userId: true },
          }),
    ]);
    if (
      !spaceMember ||
      !access?.active ||
      binding.state !== "ready" ||
      binding.validUntil.getTime() <= Date.now() ||
      !installation ||
      installation.state !== "ready" ||
      installation.serverId !== binding.serverId ||
      installation.centralOrganizationId !== binding.centralOrganizationId ||
      installation.localOrganizationId !== binding.localOrganizationId ||
      installation.bindingVersion !== binding.bindingVersion
    )
      throw new Error("Workspace access denied");
    const grant = await prisma.organizationVaultGrant.findUnique({
      where: { spaceId: actor.spaceId },
    });
    return {
      kind: "shared" as const,
      organizationId: binding.localOrganizationId,
      bindingVersion: binding.bindingVersion,
      granted:
        grant?.organizationId === binding.localOrganizationId &&
        grant.bindingVersion === binding.bindingVersion,
    };
  });
}
