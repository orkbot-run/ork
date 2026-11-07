// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { ManagedConnectorProvider } from "@orkbot/adapter-kit";
import type { ConnectorRegistry } from "./composio-connector.js";

export class ConnectorUnavailableError extends Error {
  constructor() {
    super("Connector is not configured");
    this.name = "ConnectorUnavailableError";
  }
}

/** Existing cards without an id belong to their original adapter, regardless of new configuration. */
export function legacyConnectorId(): string {
  return "composio";
}

export async function resolveConfiguredConnector(
  registry: ConnectorRegistry,
  id?: string,
): Promise<ManagedConnectorProvider | undefined> {
  const provider = registry.managed(id ?? legacyConnectorId());
  if (!provider || (provider.isConfigured && !(await provider.isConfigured()))) return undefined;
  return provider;
}
