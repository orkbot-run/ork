// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { InstallationConfiguration } from "@orkbot/auth/installation-client";
import type { WorkspaceLifecycleOperation } from "@orkbot/contracts";
import type { SpaceDeletionDeps } from "./space-deletion.js";
import { deleteSpaceWithContent } from "./space-deletion.js";
import {
  claimWorkspaceLifecycleReceipt,
  completeWorkspaceLifecycleReceipt,
  renewWorkspaceLifecycleReceipt,
} from "./workspace-lifecycle-receipt.js";
import { sweepWorkspaceLifecycleStorage } from "./workspace-lifecycle-sweep.js";

/** Delete children first and the root binding last; a durable lease allows recovery
 * after a restart without losing the scope or acknowledging incomplete cleanup. */
export async function removeManagedWorkspace(
  deps: SpaceDeletionDeps,
  configuration: InstallationConfiguration,
  operation: WorkspaceLifecycleOperation,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const receipt = await claimWorkspaceLifecycleReceipt(deps.prisma, configuration, operation);
  if (!receipt) return false;
  if (receipt.complete) return true;
  const abort = new AbortController();
  const workSignal = AbortSignal.any([signal, abort.signal]);
  let active = true;
  const renewal = setInterval(() => {
    void renewWorkspaceLifecycleReceipt(deps.prisma, operation.operationId, receipt.claimId)
      .then((renewed) => {
        if (active && !renewed) abort.abort(new Error("Workspace deletion lease expired"));
      })
      .catch((error) => {
        if (active) abort.abort(error);
      });
  }, 60_000);
  renewal.unref?.();
  try {
    const root = operation.localWorkspaceId!;
    const spaces = [...receipt.spaceIds.filter((id) => id !== root), root];
    for (const spaceId of spaces) {
      workSignal.throwIfAborted();
      if (
        !(await renewWorkspaceLifecycleReceipt(deps.prisma, operation.operationId, receipt.claimId))
      )
        throw new Error("Workspace deletion lease expired");
      await deleteSpaceWithContent(deps, { spaceId: root, userId: "system" }, spaceId, workSignal, {
        operationId: operation.operationId,
        claimId: receipt.claimId,
        spaceId,
      });
    }
    workSignal.throwIfAborted();
    await sweepWorkspaceLifecycleStorage(deps, operation.operationId, workSignal);
    workSignal.throwIfAborted();
    await completeWorkspaceLifecycleReceipt(deps.prisma, operation.operationId, receipt.claimId);
    return true;
  } finally {
    active = false;
    clearInterval(renewal);
  }
}
