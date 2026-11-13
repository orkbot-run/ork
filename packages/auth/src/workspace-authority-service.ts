// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { RealtimeFanout } from "@orkbot/adapter-kit";
import type { InstallationClient } from "./installation-client.js";
import type { WorkspaceAuthority } from "./workspace-authority.js";

/** Each API or worker process must acquire its own fresh authority after startup. */
export function startWorkspaceAuthority(
  installation: InstallationClient,
  authority: WorkspaceAuthority,
  onError: (error: unknown) => void,
  realtime?: RealtimeFanout,
): () => Promise<void> {
  let stopped = false;
  let active: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => Promise<void>) | undefined;
  let subscribedServer: string | undefined;
  let refreshing = false;
  let again = false;
  const tick = async () => {
    if (stopped) return;
    if (refreshing) {
      again = true;
      return;
    }
    refreshing = true;
    clearTimeout(timer);
    try {
      const configuration = await installation.configuration();
      if (configuration) {
        if (realtime && subscribedServer !== configuration.serverId) {
          await unsubscribe?.();
          unsubscribe = await realtime.subscribe(
            `installation-authority:${configuration.serverId}`,
            (payload) => {
              if (stopped) return;
              try {
                const event = JSON.parse(payload) as { source?: unknown; ids?: unknown };
                if (
                  event.source === authority.processId ||
                  typeof event.source !== "string" ||
                  !Array.isArray(event.ids) ||
                  !event.ids.length ||
                  event.ids.length > 64 ||
                  event.ids.some((id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
                )
                  return;
                for (const id of event.ids) authority.invalidate(id);
                if (refreshing) again = true;
                else active = tick();
              } catch {
                /* Invalid fanout cannot create authority. */
              }
            },
          );
          subscribedServer = configuration.serverId;
        }
        const projection = await authority.synchronize();
        let provisioned = false;
        for (const workspace of projection.workspaces) {
          if (workspace.state !== "provisioning") continue;
          try {
            await authority.provisionWorkspace(workspace.id);
            provisioned = true;
          } catch (error) {
            if (!stopped) onError(error);
          }
        }
        if (provisioned) await authority.synchronize();
      }
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      refreshing = false;
      if (!stopped) {
        timer = setTimeout(
          () => {
            active = tick();
          },
          again ? 0 : 30_000,
        );
        again = false;
        timer.unref?.();
      }
    }
  };
  active = tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await unsubscribe?.();
    await active;
    authority.dispose();
  };
}
