// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AgentHomeStore, SandboxProvider } from "@orkbot/adapter-kit";
import { suspendWorkspaceComputers, WorkspaceStoragePreservationError } from "@orkbot/adapters";
import type { InstallationClient } from "@orkbot/auth";
import type { PrismaClient } from "@orkbot/db";
import type { SpaceDeletionDeps } from "./space-deletion.js";
import { WorkspaceExternalMemoryError } from "./workspace-lifecycle-receipt.js";
import { removeManagedWorkspace } from "./workspace-lifecycle-remove.js";
import { sweepCompletedWorkspaceLifecycles } from "./workspace-lifecycle-sweep.js";

/** Only the installation holding the private key can fetch and acknowledge its work.
 * Each pending operation is retried independently, including after a process restart. */
export function startWorkspaceLifecycle(
  deps: SpaceDeletionDeps & {
    installation: InstallationClient;
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
  },
  onError: (error: unknown) => void,
): () => Promise<void> {
  const abort = new AbortController();
  const active = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: Promise<void> | undefined;
  let sweep: Promise<void> | undefined;
  const tick = async () => {
    try {
      const configuration = await deps.installation.configuration();
      if (!configuration || abort.signal.aborted) return;
      if (!sweep) {
        sweep = sweepCompletedWorkspaceLifecycles(deps, configuration, abort.signal)
          .catch((error) => {
            if (!abort.signal.aborted) onError(error);
          })
          .finally(() => {
            sweep = undefined;
          });
      }
      const operations = await deps.installation.pendingWorkspaceLifecycle(configuration);
      for (const operation of operations) {
        if (abort.signal.aborted) break;
        if (active.has(operation.operationId)) continue;
        const work = (async () => {
          const complete =
            operation.kind === "archive"
              ? await suspendWorkspaceComputers(
                  deps,
                  configuration,
                  operation,
                  AbortSignal.any([abort.signal, AbortSignal.timeout(10 * 60_000)]),
                )
              : await removeManagedWorkspace(deps, configuration, operation, abort.signal);
          if (complete) {
            abort.signal.throwIfAborted();
            await deps.installation.acknowledgeWorkspaceLifecycle(
              operation.operationId,
              configuration,
            );
          }
        })()
          .catch(async (error) => {
            if (abort.signal.aborted) return;
            onError(error);
            const code =
              error instanceof WorkspaceExternalMemoryError
                ? "external_memory"
                : error instanceof WorkspaceStoragePreservationError
                  ? "nonpersistent_storage"
                  : operation.kind === "delete"
                    ? "cleanup_failed"
                    : "archive_failed";
            if (code)
              await deps.installation
                .reportWorkspaceLifecycleError(operation.operationId, code, configuration)
                .catch((reportError) => {
                  if (!abort.signal.aborted) onError(reportError);
                });
          })
          .finally(() => active.delete(operation.operationId));
        active.set(operation.operationId, work);
      }
    } catch (error) {
      if (!abort.signal.aborted) onError(error);
    } finally {
      if (!abort.signal.aborted) {
        timer = setTimeout(() => {
          poll = tick();
        }, 30_000);
        timer.unref?.();
      }
    }
  };
  poll = tick();
  return async () => {
    abort.abort();
    clearTimeout(timer);
    await poll;
    await sweep;
    await Promise.allSettled(active.values());
  };
}
