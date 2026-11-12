// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { listPiCatalog } from "@orkbot/adapters";
import type { Actor, ModelCatalogEntry, ModelCredential } from "@orkbot/contracts";
import type { RouterDeps } from "#modules/platform/router";

/** Managed workspaces never probe a member's personal credentials to build a model picker. */
export async function installationCatalog(
  deps: RouterDeps,
  actor: Actor,
): Promise<ModelCatalogEntry[] | null> {
  const scoped = await deps.serverAIModels?.actor(actor);
  if (!scoped || !deps.serverAI) return null;
  const catalog = listPiCatalog();
  const offered = new Map<string, ModelCatalogEntry>();
  for (const account of await deps.serverAI.list(scoped)) {
    if (!account.enabled || account.state !== "active") continue;
    for (const id of account.allowedModels.filter((model) => account.models.includes(model))) {
      const key = JSON.stringify([account.provider, id]);
      const known = catalog.find((row) => row.provider === account.provider && row.id === id);
      const existing = offered.get(key);
      offered.set(key, {
        ...(known ?? { provider: account.provider, id, label: id }),
        managed: true,
        billing: "Server connection",
        credentialIds: [...(existing?.credentialIds ?? []), account.id],
      });
    }
  }
  return [...offered.values()];
}

export async function installationCredentials(
  deps: RouterDeps,
  actor: Actor,
): Promise<ModelCredential[] | null> {
  const scoped = await deps.serverAIModels?.actor(actor);
  if (!scoped || !deps.serverAI) return null;
  return (await deps.serverAI.list(scoped))
    .filter((account) => account.enabled && account.state === "active")
    .map((account) => ({
      id: account.id,
      provider: account.provider,
      label: account.label,
      managed: true,
      hasKey: true,
      isDefault: account.isDefault,
      enabledModelIds: account.allowedModels.filter((id) => account.models.includes(id)),
    }));
}
