// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { z } from "zod";
import type { IdentityCatalog } from "./identity.js";

export const WorkspaceTargetSchema = z
  .object({
    organizationId: z.string().uuid(),
    serverId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    bindingVersion: z.number().int().positive(),
    keyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type WorkspaceTarget = z.infer<typeof WorkspaceTargetSchema>;

/** Explicit links never fall back to another organization or an unrelated workspace. */
export function catalogWorkspace(
  catalog: IdentityCatalog,
  target: {
    organizationId: string;
    serverId: string;
    workspaceId: string;
  },
) {
  const organization = catalog.organizations.find((row) => row.id === target.organizationId);
  const server = organization?.servers.find((row) => row.id === target.serverId);
  const workspace = server?.workspaces.find((row) => row.id === target.workspaceId);
  if (
    !organization ||
    !server ||
    !workspace?.canOpen ||
    workspace.state !== "ready" ||
    server.state !== "ready" ||
    !server.keyFingerprint
  )
    return null;
  return {
    organization,
    server,
    workspace,
    target: WorkspaceTargetSchema.parse({
      ...target,
      bindingVersion: server.bindingVersion,
      keyFingerprint: server.keyFingerprint,
    }),
  };
}

export function initialCatalogOrganization(catalog: IdentityCatalog) {
  return (
    catalog.organizations.find((row) => row.id === catalog.defaultOrganizationId) ??
    (catalog.organizations.length === 1 ? catalog.organizations[0]! : null)
  );
}

/** Restore an authorized choice even while its route is unavailable, without selecting another one. */
export function initialCatalogWorkspace(
  catalog: IdentityCatalog,
  organizationId: string,
  previous?: { serverId: string; workspaceId: string } | null,
) {
  const organization = catalog.organizations.find((row) => row.id === organizationId);
  const choices =
    organization?.servers.flatMap((server) =>
      server.workspaces
        .filter((workspace) => workspace.canOpen)
        .map((workspace) => ({ organizationId, serverId: server.id, workspaceId: workspace.id })),
    ) ?? [];
  return (
    choices.find(
      (row) => row.serverId === previous?.serverId && row.workspaceId === previous.workspaceId,
    ) ?? (choices.length === 1 ? choices[0]! : null)
  );
}

export function parseWorkspaceLink(
  value: string,
): { organizationId: string; serverId: string; workspaceId: string } | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "orkbot:" ||
      url.hostname !== "workspace" ||
      url.pathname ||
      url.hash ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    const keys = ["organization", "server", "workspace"];
    if (
      [...url.searchParams.keys()].length !== 3 ||
      keys.some((key) => url.searchParams.getAll(key).length !== 1) ||
      [...url.searchParams.keys()].some((key) => !keys.includes(key))
    )
      return null;
    return z
      .object({
        organizationId: z.string().uuid(),
        serverId: z.string().uuid(),
        workspaceId: z.string().uuid(),
      })
      .parse({
        organizationId: url.searchParams.get("organization"),
        serverId: url.searchParams.get("server"),
        workspaceId: url.searchParams.get("workspace"),
      });
  } catch {
    return null;
  }
}
