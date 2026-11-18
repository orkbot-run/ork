// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Actor } from "@orkbot/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";

type AdmissionClient = Pick<PrismaClient, "space" | "centralWorkspaceBinding">;

/** Resolve the Accounts admission for a managed Space without consulting other organizations. */
export async function workspaceAdmissionBinding(prisma: AdmissionClient, spaceId: string) {
  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    select: { organizationId: true, admissionWorkspaceId: true, centralBinding: true },
  });
  if (!space) return null;
  if (space.centralBinding) return space.centralBinding;
  if (!space.admissionWorkspaceId) return null;
  return prisma.centralWorkspaceBinding.findFirst({
    where: { id: space.admissionWorkspaceId, localOrganizationId: space.organizationId },
  });
}

/** A managed login can navigate within its own admission and server-owned member Spaces. */
export async function workspaceNavigationFilter(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId">,
): Promise<Prisma.SpaceWhereInput> {
  const binding = await runAsSystem("check the navigation workspace binding", () =>
    workspaceAdmissionBinding(prisma, actor.spaceId),
  );
  return binding
    ? {
        organizationId: binding.localOrganizationId,
        OR: [{ id: binding.spaceId }, { admissionWorkspaceId: binding.id, centralBinding: null }],
      }
    : { centralBinding: null, admissionWorkspaceId: null };
}
