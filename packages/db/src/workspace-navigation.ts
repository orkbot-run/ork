// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Actor } from "@orkbot/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";

/** Local membership never expands a central workspace session's navigation capability. */
export async function workspaceNavigationFilter(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId">,
): Promise<Prisma.SpaceWhereInput> {
  const managed = await runAsSystem("check the navigation workspace binding", () =>
    prisma.centralWorkspaceBinding.findUnique({
      where: { spaceId: actor.spaceId },
      select: { id: true },
    }),
  );
  // The Accounts catalog is the only way to enter another managed workspace.
  return managed ? { id: actor.spaceId } : { centralBinding: null };
}
