import type { Prisma } from "./client.js";

/**
 * Skills, MCP servers and plugin or tool-source installs belong to the account that added them.
 * Each is available in the space it was added in (`spaceId`), in every space of its owner
 * (`allSpaces`, which includes spaces created later), or also in chosen further spaces
 * (`availableIn`). Nobody but the owner ever sees them.
 */
export function availableInSpace(scope: { spaceId: string; userId: string }) {
  return {
    userId: scope.userId,
    OR: [
      { spaceId: scope.spaceId },
      { allSpaces: true },
      { availableIn: { some: { spaceId: scope.spaceId } } },
    ],
  };
}

/** An item's secret is this space's or, once the item reaches further spaces, the account's. */
export function itemSecretIn(scope: { spaceId: string; userId: string }) {
  return { userId: scope.userId, OR: [{ spaceId: scope.spaceId }, { spaceId: null }] };
}

/** Managed workspaces must never create account-wide secrets, even for legacy shared items. */
export async function itemSecretSpace(
  tx: Prisma.TransactionClient,
  spaceId: string,
  shared: boolean,
): Promise<string | null> {
  if (!shared) return spaceId;
  const [scope] = await tx.$queryRaw<Array<{ managed: boolean }>>`
    SELECT public.app_central_scope_is_managed() AS managed
  `;
  return scope?.managed === false ? null : spaceId;
}

/** Select alongside a row so `spaceAvailability` can describe it. */
export const AVAILABILITY_SELECT = { select: { spaceId: true } } as const;

export type SpaceAvailability = { allSpaces: boolean; spaceIds: string[] };

/** The spaces an item is available in, starting with the one it was added in. */
export function spaceAvailability(row: {
  spaceId: string;
  allSpaces: boolean;
  availableIn?: Array<{ spaceId: string }>;
}): SpaceAvailability {
  return {
    allSpaces: row.allSpaces,
    spaceIds: [
      row.spaceId,
      ...(row.availableIn ?? []).map((entry) => entry.spaceId).filter((id) => id !== row.spaceId),
    ],
  };
}
