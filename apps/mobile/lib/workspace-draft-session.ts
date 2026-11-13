// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import forge from "node-forge";
import { installationRevocationScope } from "./installation-transport";

let active: { account: string; epoch: string } | undefined;

export function clearWorkspaceDraftSession(): void {
  active = undefined;
}

export async function hydrateWorkspaceDraftSession(current: () => boolean): Promise<void> {
  const { accountsDraftSession } = await import("./accounts");
  const identity = await accountsDraftSession();
  if (current()) active = identity ?? undefined;
}

export const hasManagedWorkspace = (apiBase: string) => !!installationRevocationScope(apiBase);

/** Persistent ownership includes the browser-login lifetime and the complete installation binding. */
export function workspaceDraftOwner(apiBase: string, userId: string): string | undefined {
  const selected = installationRevocationScope(apiBase);
  if (!selected || !active || selected.account !== active.account) return undefined;
  return forge.md.sha256
    .create()
    .update(
      JSON.stringify([
        active.epoch,
        selected.account,
        selected.target.organizationId,
        selected.target.serverId,
        selected.target.workspaceId,
        selected.target.bindingVersion,
        selected.target.keyFingerprint,
        userId,
      ]),
      "utf8",
    )
    .digest()
    .toHex();
}
