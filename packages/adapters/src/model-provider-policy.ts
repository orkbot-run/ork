// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ModelConnectionMetadata } from "@orkbot/contracts";
import { canonicalPiProviderId, OPENAI_COMPATIBLE_PROVIDER_ID } from "@orkbot/contracts";
import { modelConnectionMetadata } from "./model-connection-metadata.js";

const COMPATIBLE = OPENAI_COMPATIBLE_PROVIDER_ID;
const presets = modelConnectionMetadata(COMPATIBLE)?.presets ?? [];
const presetByHost = new Map(
  presets.map((preset) => [new URL(preset.baseUrl).hostname, preset.id]),
);

export const MODEL_PROVIDER_BLOCKED_MESSAGE =
  "This model provider is blocked by the server administrator.";

export class ModelProviderBlockedError extends Error {
  constructor() {
    super(MODEL_PROVIDER_BLOCKED_MESSAGE);
    this.name = "ModelProviderBlockedError";
  }
}

let parsedPolicy: { value: string; ids: ReadonlySet<string> } | undefined;
function allowedProviderIds(): ReadonlySet<string> | undefined {
  const value = process.env.ORKBOT_MODEL_PROVIDER_ALLOWLIST?.trim();
  if (!value) return undefined;
  if (parsedPolicy?.value !== value) {
    const ids = value
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean);
    parsedPolicy = { value, ids: new Set(ids.map(canonicalPiProviderId)) };
  }
  return parsedPolicy.ids;
}

/** Coarse check that can run before loading any stored credential. */
export function isModelProviderAllowed(provider: string): boolean {
  const ids = allowedProviderIds();
  if (!ids) return true;
  const canonical = canonicalPiProviderId(provider);
  return (
    ids.has(canonical) ||
    (canonical === COMPATIBLE && presets.some(({ id }) => id !== undefined && ids.has(id)))
  );
}

/** Known preset hosts keep their identity if a caller enters a different path or port. */
export function isModelEndpointAllowed(provider: string, baseUrl?: string | null): boolean {
  const ids = allowedProviderIds();
  if (!ids) return true;
  const canonical = canonicalPiProviderId(provider);
  if (canonical !== COMPATIBLE) return ids.has(canonical);
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.replace(/\.$/, "");
    if (!presetByHost.has(hostname)) return ids.has(COMPATIBLE);
    const preset = presetByHost.get(hostname);
    return preset !== undefined && ids.has(preset);
  } catch {
    return false;
  }
}

export function assertModelProviderAllowed(provider: string): void {
  if (!isModelProviderAllowed(provider)) throw new ModelProviderBlockedError();
}

export function assertModelEndpointAllowed(provider: string, baseUrl?: string | null): void {
  if (!isModelEndpointAllowed(provider, baseUrl)) throw new ModelProviderBlockedError();
}

export function filterAllowedModelCatalog<
  T extends { provider: string; connection?: ModelConnectionMetadata },
>(entries: T[]): T[] {
  const ids = allowedProviderIds();
  if (!ids) return entries;
  return entries
    .filter(({ provider }) => isModelProviderAllowed(provider))
    .map((entry) => {
      if (canonicalPiProviderId(entry.provider) !== COMPATIBLE) return entry;
      return {
        ...entry,
        connection: {
          ...entry.connection,
          presets: (entry.connection?.presets ?? presets).filter(({ baseUrl }) =>
            isModelEndpointAllowed(COMPATIBLE, baseUrl),
          ),
          customEndpointAllowed: ids.has(COMPATIBLE),
        },
      };
    });
}
