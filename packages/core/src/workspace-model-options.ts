// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ModelCatalogEntry } from "@orkbot/contracts";
import { modelSupportsRole } from "@orkbot/contracts";
import { modelConnectionOptions } from "./model-connection-form.js";

/** The app's own catalog, limited to models runnable with an API key as the main model. */
export function workspaceApiModelCatalog(catalog: readonly ModelCatalogEntry[]) {
  return catalog.filter((entry) => entry.auth !== "oauth" && modelSupportsRole(entry, "main"));
}

export function workspaceApiProviders(catalog: readonly ModelCatalogEntry[]) {
  return modelConnectionOptions(workspaceApiModelCatalog(catalog)).filter(
    (entry) => !entry.baseUrl,
  );
}

export function workspaceApiModels(catalog: readonly ModelCatalogEntry[], provider: string) {
  return workspaceApiModelCatalog(catalog).filter(
    (entry) => entry.provider === provider && !entry.placeholder,
  );
}
