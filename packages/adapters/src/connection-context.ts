import type { AdapterContext } from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import type { PluginConnectionRow } from "./composio-connector.js";
import { planLiveConnectionSync } from "./composio-connector.js";
import type { ExecutorDeps } from "./executor-deps.js";

export function selectRunConnections<
  T extends { connectorId: string; provider: string; status: string },
>(rows: T[], connectedComposioProviders: string[]): T[] {
  const liveProviders = new Set(
    connectedComposioProviders.map((provider) => provider.trim().toLowerCase()).filter(Boolean),
  );
  const connectedKeys = new Set(
    rows
      .filter((row) => row.status === "connected")
      .map((row) => `${row.connectorId}:${row.provider.trim().toLowerCase()}`),
  );
  return rows.filter((row) => {
    if (row.status === "connected") return true;
    if (row.status === "revoked") return false;
    // Recover a pending/error Composio row only when this provider has no
    // connected row of its own. A sibling that shares the slug must not
    // pull a non-live row — and its dead providerRef — into the run.
    if (row.connectorId !== "composio") return false;
    if (row.status !== "pending" && row.status !== "error") return false;
    const providerKey = row.provider.trim().toLowerCase();
    if (!liveProviders.has(providerKey)) return false;
    return !connectedKeys.has(`composio:${providerKey}`);
  });
}

/** Authorized connection metadata shared by model runs and unattended checks. */
export function connectedContext(
  rows: Array<{
    id: string;
    connectorId: string;
    provider: string;
    displayName: string;
    providerRef: string | null;
  }>,
): Pick<AdapterContext, "connectedConnections" | "connectedProviders"> {
  return {
    connectedConnections: rows.map((row) => ({
      id: row.id,
      connectorId: row.connectorId,
      externalId: row.provider,
      displayName: row.displayName,
      providerRef: row.providerRef ?? undefined,
    })),
    connectedProviders: rows
      .filter((row) => row.connectorId === "composio")
      .map((row) => row.provider),
  };
}

export async function loadLivePluginSlugs(
  listConnectedPluginSlugs: ExecutorDeps["listConnectedPluginSlugs"],
  userId: string,
  signal?: AbortSignal,
): Promise<{ ok: true; slugs: string[] } | { ok: false }> {
  if (!listConnectedPluginSlugs) return { ok: false };
  try {
    return { ok: true, slugs: await listConnectedPluginSlugs(userId, signal) };
  } catch {
    return { ok: false };
  }
}

export async function persistLivePluginConnections(
  prisma: PrismaClient,
  owner: { userId: string; spaceId: string },
  rows: PluginConnectionRow[],
  liveSlugs: string[],
  activeRefs?: string[] | null,
): Promise<void> {
  const sync = planLiveConnectionSync(rows, liveSlugs, activeRefs);
  for (const [ids, status] of [
    [sync.connectIds, "connected"],
    [sync.revokeIds, "revoked"],
  ] as const) {
    if (ids.length === 0) continue;
    const updated = await prisma.connection.updateManyAndReturn({
      where: {
        id: { in: ids },
        userId: owner.userId,
        spaceId: owner.spaceId,
        status: { in: ["pending", "error"] },
        OR: rows
          .filter((row) => ids.includes(row.id))
          .map((row) => ({
            id: row.id,
            ...(row.providerRef !== undefined ? { providerRef: row.providerRef } : {}),
            ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
          })),
      },
      data: { status },
      select: { id: true },
    });
    const updatedIds = new Set(updated.map((row) => row.id));
    for (const row of rows) {
      if (updatedIds.has(row.id)) row.status = status;
    }
  }
}
