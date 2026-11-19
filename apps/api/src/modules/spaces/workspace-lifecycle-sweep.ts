// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { purgeAgentHome } from "@orkbot/adapters";
import type { InstallationConfiguration } from "@orkbot/auth/installation-client";
import { runAsSystem } from "@orkbot/db";
import type { SpaceDeletionDeps } from "./space-deletion.js";

/** Sweep recorded namespaces only after no corresponding Space or computer exists.
 * Receipts survive acknowledgement so an interrupted upload cannot leave an orphan forever. */
export async function sweepWorkspaceLifecycleStorage(
  deps: SpaceDeletionDeps,
  operationId: string,
  signal: AbortSignal,
) {
  return runAsSystem("sweep the storage of a deleted workspace", async () => {
    const receipt = await deps.prisma.workspaceLifecycleReceipt.findUnique({
      where: { operationId },
    });
    if (
      !receipt ||
      !Array.isArray(receipt.spaceIds) ||
      !Array.isArray(receipt.homeKeys) ||
      !Array.isArray(receipt.homeStorageIds) ||
      receipt.spaceIds.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) ||
      receipt.homeKeys.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) ||
      receipt.homeStorageIds.some((id) => typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))
    )
      throw new Error("Workspace cleanup manifest is invalid");
    const spaceIds = receipt.spaceIds as string[];
    const homeKeys = receipt.homeKeys as string[];
    const homeStorageIds = receipt.homeStorageIds as string[];
    const [spaces, computers] = await Promise.all([
      deps.prisma.space.count({ where: { id: { in: spaceIds } } }),
      deps.prisma.computer.count({ where: { homeKey: { in: homeKeys } } }),
    ]);
    if (spaces || computers) throw new Error("Workspace cleanup scope is still in use");
    if (!deps.artifacts.purgeSpace) throw new Error("Artifact storage cannot delete a workspace");
    if (homeStorageIds.length && !deps.home.purgeStorageIds)
      throw new Error("Home storage cannot sweep deleted workspace revisions");
    for (const spaceId of spaceIds) {
      signal.throwIfAborted();
      await deps.artifacts.purgeSpace({
        operationId: `workspace.sweep:${operationId}`,
        traceId: `workspace.sweep:${operationId}`,
        spaceId,
        userId: "system",
        signal,
      });
    }
    for (const homeKey of homeKeys) {
      signal.throwIfAborted();
      await purgeAgentHome(deps.home, homeKey);
    }
    signal.throwIfAborted();
    if (homeStorageIds.length) await deps.home.purgeStorageIds!(homeStorageIds);
    await deps.prisma.workspaceLifecycleReceipt.updateMany({
      where: { operationId },
      data: { lastSweepAt: new Date() },
    });
  });
}

/** Retry late or interrupted storage writes in a bounded, rotating batch. */
export async function sweepCompletedWorkspaceLifecycles(
  deps: SpaceDeletionDeps,
  configuration: InstallationConfiguration,
  signal: AbortSignal,
) {
  const due = await runAsSystem("find completed workspace storage sweeps", () =>
    deps.prisma.workspaceLifecycleReceipt.findMany({
      where: {
        state: "complete",
        serverId: configuration.serverId,
        centralOrganizationId: configuration.organizationId,
        keyFingerprint: configuration.keyFingerprint,
        bindingVersion: configuration.bindingVersion,
        OR: [{ lastSweepAt: null }, { lastSweepAt: { lte: new Date(Date.now() - 60 * 60_000) } }],
      },
      select: { operationId: true },
      orderBy: { lastSweepAt: "asc" },
      take: 16,
    }),
  );
  const errors: unknown[] = [];
  for (const receipt of due) {
    signal.throwIfAborted();
    try {
      await sweepWorkspaceLifecycleStorage(deps, receipt.operationId, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      errors.push(error);
      // A failing provider must not keep every later receipt out of the batch.
      await runAsSystem("defer a failed workspace storage sweep", () =>
        deps.prisma.workspaceLifecycleReceipt.updateMany({
          where: { operationId: receipt.operationId, state: "complete" },
          data: { lastSweepAt: new Date() },
        }),
      );
    }
  }
  if (errors.length) throw new AggregateError(errors, "Workspace storage sweep failed");
}
