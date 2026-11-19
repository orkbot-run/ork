// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AgentHomeStore, SandboxProvider } from "@orkbot/adapter-kit";
import type { WorkspaceLifecycleOperation } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { clearEndedExecutionRunBinding, recordComputerRunEnd, runAsSystem } from "@orkbot/db";
import { revokeScreenControl } from "./computer-control.js";
import { toComputerRef } from "./computer-support.js";
import { checkpointComputerWorkspace } from "./computer-workspace.js";

export class WorkspaceStoragePreservationError extends Error {
  constructor() {
    super("This computer's provider cannot preserve its complete disk when stopped");
  }
}

/** Resolve every local Space admitted under a centrally managed workspace.
 * This is a snapshot, not a claim: callers must fence each side effect against
 * the current binding and lifecycle operation before changing data. */
export async function workspaceLifecycleSpaces(
  prisma: PrismaClient,
  installation: { serverId: string; organizationId: string; bindingVersion: number },
  operation: WorkspaceLifecycleOperation,
): Promise<string[]> {
  return runAsSystem("resolve a workspace lifecycle operation", async () => {
    const binding = await prisma.centralWorkspaceBinding.findUnique({
      where: { id: operation.workspaceId },
    });
    if (
      !binding ||
      binding.serverId !== installation.serverId ||
      binding.centralOrganizationId !== installation.organizationId ||
      binding.bindingVersion !== installation.bindingVersion ||
      binding.permissionVersion !== operation.permissionVersion ||
      binding.state !== "disabled" ||
      binding.validUntil.getTime() <= Date.now() ||
      !operation.localOrganizationId ||
      !operation.localWorkspaceId ||
      binding.localOrganizationId !== operation.localOrganizationId ||
      binding.spaceId !== operation.localWorkspaceId
    )
      throw new Error("Workspace lifecycle binding is unavailable or changed");

    const spaces = await prisma.space.findMany({
      where: {
        organizationId: binding.localOrganizationId,
        OR: [{ id: binding.spaceId }, { admissionWorkspaceId: binding.id, centralBinding: null }],
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    if (!spaces.some((space) => space.id === binding.spaceId))
      throw new Error("Workspace lifecycle root is unavailable");
    return spaces.map((space) => space.id);
  });
}

/** Stop the workspace's computers only after their current work has yielded and their data
 * has been saved. A false result means the caller must retry and must not acknowledge the
 * archive. This does not destroy the provider's disk or delete any workspace rows. */
export async function suspendWorkspaceComputers(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider; home: AgentHomeStore },
  installation: { serverId: string; organizationId: string; bindingVersion: number },
  operation: WorkspaceLifecycleOperation,
  signal: AbortSignal,
): Promise<boolean> {
  if (operation.kind !== "archive") throw new Error("Expected a workspace archive operation");
  return runAsSystem("suspend computers for an archived workspace", async () => {
    const spaces = await workspaceLifecycleSpaces(deps.prisma, installation, operation);
    const running = await deps.prisma.run.count({
      where: { spaceId: { in: spaces }, status: { in: ["leased", "running"] } },
    });
    if (running) {
      // A dead worker cannot retire its own run after its lease expires. Cancel only
      // expired managed runs; the next pass still waits for every live lease to yield.
      await deps.prisma.run.updateMany({
        where: {
          spaceId: { in: spaces },
          centralWorkspaceId: operation.workspaceId,
          status: { in: ["leased", "running"] },
          leaseExpiresAt: { lte: new Date() },
        },
        data: { status: "cancelled", completedAt: new Date() },
      });
      return false;
    }
    const computers = await deps.prisma.computer.findMany({
      where: { spaceId: { in: spaces } },
      orderBy: { id: "asc" },
    });
    for (const computer of computers) {
      signal.throwIfAborted();
      if (computer.state === "booting" || computer.maintenanceId) return false;
      // Match the idle-computer reconciler's abandoned-claim window. A newer claim may
      // still be exporting or stopping, including from a different server process.
      if (
        computer.state === "suspending" &&
        Date.now() - computer.updatedAt.getTime() < 60 * 60_000
      )
        return false;
      if (!computer.providerRef) {
        if (computer.state !== "stopped" && computer.state !== "suspended") return false;
        continue;
      }
      if (computer.state === "suspended") continue;
      if (!["running", "stopped", "suspending"].includes(computer.state)) return false;
      if (computer.kind === "desktop") throw new WorkspaceStoragePreservationError();
      if (computer.executionRunId) {
        await clearEndedExecutionRunBinding(deps.prisma, computer.id);
        return false;
      }
      const ref = toComputerRef(computer);
      const context = {
        operationId: `workspace.archive:${operation.operationId}`,
        traceId: `workspace.archive:${operation.operationId}`,
        spaceId: computer.spaceId,
        userId: computer.userId,
        signal,
      };
      // Portable exports deliberately omit caches and dependencies. Until a provider can
      // prove it retains the complete disk, stopping it cannot satisfy archive preservation.
      const keepsHome = deps.sandbox.keepsHome
        ? await deps.sandbox.keepsHome(ref)
        : deps.sandbox.describe().capabilities.persistentHome;
      if (!keepsHome) throw new WorkspaceStoragePreservationError();
      const claimedAt = new Date();
      const claimed = await deps.prisma.computer.updateMany({
        where: {
          id: computer.id,
          spaceId: computer.spaceId,
          state: computer.state,
          providerRef: computer.providerRef,
          updatedAt: computer.updatedAt,
          maintenanceId: null,
          executionRunId: null,
          restorePending: false,
          executionLeases: { none: { expiresAt: { gt: claimedAt } } },
        },
        data: { state: "suspending", updatedAt: claimedAt },
      });
      if (claimed.count !== 1) return false;
      const claim = {
        id: computer.id,
        state: "suspending",
        providerRef: computer.providerRef,
        updatedAt: claimedAt,
      };
      try {
        await revokeScreenControl(deps, computer, context, computer.controlLeaseId ?? undefined, {
          clearGoneRef: false,
        });
        // A previously stopped computer or an abandoned suspend may already have
        // stopped at its provider. Its retained disk remains the source of truth;
        // explicitly stop again instead of treating an inconclusive status as success.
        const revision = ["stopped", "suspending"].includes(computer.state)
          ? undefined
          : await checkpointComputerWorkspace(
              deps.home,
              deps.sandbox,
              computer.homeKey,
              ref,
              context,
              { prisma: deps.prisma, computer },
            );
        if (computer.state === "running" && revision === undefined) return false;
        // The projection may have changed while the provider was saving.
        await workspaceLifecycleSpaces(deps.prisma, installation, operation);
        const saved = await deps.prisma.computer.updateMany({
          where: {
            ...claim,
            executionRunId: null,
            executionLeases: { none: { expiresAt: { gt: new Date() } } },
          },
          data: {
            ...(revision === undefined
              ? {}
              : { homeRevision: revision, homeRevisionAt: claimedAt }),
            updatedAt: claimedAt,
          },
        });
        if (saved.count !== 1) return false;
        signal.throwIfAborted();
        await deps.sandbox.stop(ref, context);
        const stopped = await deps.prisma.computer.updateMany({
          where: claim,
          data: {
            state: "suspended",
            runningSince: null,
            controlHolder: "none",
            controlLeaseId: null,
            controlLeaseExpiresAt: null,
            controlBotId: null,
            controlRunId: null,
          },
        });
        if (stopped.count !== 1) return false;
        await recordComputerRunEnd(deps.prisma, computer, "idle");
      } finally {
        // An interrupted or failed checkpoint leaves the machine recoverable, not marked stopped.
        await deps.prisma.computer.updateMany({ where: claim, data: { state: computer.state } });
      }
    }
    const latestSpaces = await workspaceLifecycleSpaces(deps.prisma, installation, operation);
    if (
      latestSpaces.length !== spaces.length ||
      latestSpaces.some((id, index) => id !== spaces[index])
    )
      return false;
    // A computer or run may have been created while another process was yielding authority.
    const [unfinished, runningAfter] = await Promise.all([
      deps.prisma.computer.count({
        where: {
          spaceId: { in: spaces },
          OR: [
            { state: { notIn: ["stopped", "suspended"] } },
            { state: "stopped", providerRef: { not: null } },
          ],
        },
      }),
      deps.prisma.run.count({
        where: { spaceId: { in: spaces }, status: { in: ["leased", "running"] } },
      }),
    ]);
    return unfinished === 0 && runningAfter === 0;
  });
}
