// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { WorkspaceTarget } from "@orkbot/contracts";
import { WorkspaceTargetSchema } from "@orkbot/contracts";
import * as SecureStore from "expo-secure-store";
import forge from "node-forge";

const historyKey = (account: string, organizationId: string) =>
  `orkbot.accounts.workspace-history-v2.${forge.md.sha256.create().update(account, "utf8").digest().toHex()}.${organizationId}`;

const KEY = "orkbot.accounts.selected-workspace-v2";
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
export async function saveSelectedWorkspace(
  account: string,
  server: string,
  target?: WorkspaceTarget,
): Promise<void> {
  if (target) {
    await SecureStore.setItemAsync(
      KEY,
      JSON.stringify({ account, server, target: WorkspaceTargetSchema.parse(target) }),
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
