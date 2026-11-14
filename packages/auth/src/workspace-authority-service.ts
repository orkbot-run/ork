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
  publicOrigin?: string,
  resumeEnrollment = false,
): () => Promise<void> {
  let stopped = false;
  let active: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => Promise<void>) | undefined;
  let subscribedServer: string | undefined;
  let refreshing = false;
  let again = false;
  let publishedRoute: string | undefined;
  const tick = async () => {
    if (stopped) return;
    if (refreshing) {
      again = true;
      return;
    }
    refreshing = true;
    clearTimeout(timer);
    try {
      const configuration = resumeEnrollment
        ? await installation.resumePendingEnrollment()
        : await installation.configuration();
      if (configuration) {
        const routeKey = JSON.stringify([configuration, publicOrigin]);
        if (publicOrigin && publishedRoute !== routeKey) {
          try {
            await installation.addDirectRoute(publicOrigin, configuration);
            publishedRoute = routeKey;
          } catch (error) {
            if (!stopped)
              onError(
                new Error("Could not publish the server address; check Accounts compatibility.", {
                  cause: error,
                }),
              );
          }
        }
        if (realtime && subscribedServer !== configuration.serverId) {
          await unsubscribe?.();
          unsubscribe = await realtime.subscribe(
            `installation-authority:${configuration.serverId}`,
            (payload) => {
              if (stopped) return;
              try {
                const event = JSON.parse(payload) as {
                  source?: unknown;
                  ids?: unknown;
                  refused?: unknown;
                  serverId?: unknown;
                  bindingVersion?: unknown;
                  keyFingerprint?: unknown;
                };
                if (
                  typeof event.source === "string" &&
                  event.source !== authority.processId &&
                  event.refused === true
                ) {
                  if (
                    event.serverId !== configuration.serverId ||
                    !Number.isSafeInteger(event.bindingVersion) ||
                    Number(event.bindingVersion) < 1 ||
                    typeof event.keyFingerprint !== "string" ||
                    !/^[a-f0-9]{64}$/.test(event.keyFingerprint)
                  )
                    return;
                  void authority
                    .refuseInstallation(configuration.serverId, false, undefined, {
                      ...configuration,
                      bindingVersion: Number(event.bindingVersion),
                      keyFingerprint: event.keyFingerprint,
                    })
                    .catch(onError);
                  return;
                }
                if (
                  event.source === authority.processId ||
                  typeof event.source !== "string" ||
                  !Array.isArray(event.ids) ||
                  !event.ids.length ||
                  event.ids.length > 64 ||
                  event.ids.some((id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
                )
                  return;
                if (
                  event.serverId !== configuration.serverId ||
                  !Number.isSafeInteger(event.bindingVersion) ||
                  Number(event.bindingVersion) < 1 ||
                  typeof event.keyFingerprint !== "string" ||
                  !/^[a-f0-9]{64}$/.test(event.keyFingerprint)
                )
                  return;
                void authority
                  .invalidateProjection(
                    {
                      ...configuration,
                      bindingVersion: Number(event.bindingVersion),
                      keyFingerprint: event.keyFingerprint,
                    },
                    event.ids as string[],
                  )
                  .then((applied) => {
                    if (!applied || stopped) return;
                    if (refreshing) again = true;
                    else active = tick();
                  })
                  .catch(onError);
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
      } else publishedRoute = undefined;
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
