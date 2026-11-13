// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { InstallationRelayRoute, WorkspaceTarget } from "@orkbot/contracts";
import {
  installationRelayRouteSchema,
  installationVirtualOrigin,
  WorkspaceTargetSchema,
} from "@orkbot/contracts";
import * as SecureStore from "expo-secure-store";
import forge from "node-forge";

const historyKey = (account: string, organizationId: string) =>
  `orkbot.accounts.workspace-history-v2.${forge.md.sha256.create().update(account, "utf8").digest().toHex()}.${organizationId}`;

const KEY = "orkbot.accounts.selected-workspace-v2";
/** Selection is metadata only. Offline sign-in additionally requires the OS-held device key. */
export async function selectedWorkspaceSnapshot(): Promise<{
  account: string;
  server: string;
  target: WorkspaceTarget;
} | null> {
  try {
    const stored = JSON.parse((await SecureStore.getItemAsync(KEY)) ?? "null");
    if (typeof stored?.account !== "string" || typeof stored.server !== "string") return null;
    const owner = JSON.parse(stored.account);
    const origin = new URL(stored.server);
    if (
      !Array.isArray(owner) ||
      owner.length !== 2 ||
      owner.some((value) => typeof value !== "string" || !value) ||
      origin.protocol !== "https:" ||
      origin.origin !== stored.server ||
      origin.username ||
      origin.password
    )
      return null;
    return {
      account: stored.account,
      server: stored.server,
      target: WorkspaceTargetSchema.parse(stored.target),
    };
  } catch {
    return null;
  }
}
export async function selectedWorkspace(
  account: string,
  server: string,
): Promise<WorkspaceTarget | null> {
  try {
    const stored = JSON.parse((await SecureStore.getItemAsync(KEY)) ?? "null");
    return stored?.account === account && stored.server === server
      ? WorkspaceTargetSchema.parse(stored.target)
      : null;
  } catch {
    return null;
  }
}
export async function selectedInstallationRelay(
  account: string,
  server: string,
): Promise<InstallationRelayRoute | undefined> {
  const stored = JSON.parse((await SecureStore.getItemAsync(KEY)) ?? "null");
  if (stored?.account !== account || stored.server !== server || stored.relay === undefined)
    return undefined;
  const target = WorkspaceTargetSchema.parse(stored.target);
  if (server !== installationVirtualOrigin(target.serverId))
    throw new Error("Native connection changed");
  return installationRelayRouteSchema.parse(stored.relay);
}
export async function saveSelectedWorkspace(
  account: string,
  server: string,
  target?: WorkspaceTarget,
  relay?: InstallationRelayRoute,
): Promise<void> {
  if (target) {
    if (relay && server !== installationVirtualOrigin(target.serverId))
      throw new Error("Native connection changed");
    await SecureStore.setItemAsync(
      KEY,
      JSON.stringify({
        account,
        server,
        target: WorkspaceTargetSchema.parse(target),
        ...(relay ? { relay: installationRelayRouteSchema.parse(relay) } : {}),
      }),
    );
    await SecureStore.setItemAsync(
      historyKey(account, target.organizationId),
      JSON.stringify({ account, target }),
    );
  } else await SecureStore.deleteItemAsync(KEY);
}

export async function lastOrganizationWorkspace(
  account: string,
  organizationId: string,
): Promise<WorkspaceTarget | null> {
  try {
    const stored = JSON.parse(
      (await SecureStore.getItemAsync(historyKey(account, organizationId))) ?? "null",
    );
    if (stored?.account !== account) return null;
    const target = WorkspaceTargetSchema.parse(stored.target);
    return target.organizationId === organizationId ? target : null;
  } catch {
    return null;
  }
}
