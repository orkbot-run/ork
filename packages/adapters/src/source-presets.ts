// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { SourcePreset, SourcePresetInstall } from "@orkbot/contracts";
import { SourcePresetSchema } from "@orkbot/contracts";

export type SourcePresetDefinition = SourcePreset & {
  source?: string;
  config: Record<string, unknown>;
};

const presets: readonly SourcePresetDefinition[] = [
  {
    id: "executor",
    label: "Executor",
    kind: "mcp",
    endpoint: "input",
    credential: "required",
    config: { preset: "custom", auth: { type: "bearer" } },
  },
  {
    id: "treg",
    label: "Treg",
    kind: "mcp",
    endpoint: "fixed",
    credential: "required",
    source: "https://treg.to/mcp/",
    config: { preset: "custom", auth: { type: "bearer" } },
  },
];

export function sourcePresets(definitions = presets): SourcePreset[] {
  if (definitions.length > 64) throw new Error("Too many source presets");
  const ids = new Set<string>();
  return definitions.map((preset) => {
    const metadata = SourcePresetSchema.parse(preset);
    if (ids.has(metadata.id)) throw new Error("Duplicate source preset");
    ids.add(metadata.id);
    return metadata;
  });
}

export function resolveSourcePresetInstall(input: SourcePresetInstall, definitions = presets) {
  sourcePresets(definitions);
  const preset = definitions.find((candidate) => candidate.id === input.presetId);
  if (!preset) throw new Error("Source preset is not available");
  if (preset.endpoint === "fixed" && input.endpoint !== undefined)
    throw new Error("Source preset does not accept an endpoint");
  const source = preset.endpoint === "fixed" ? preset.source : input.endpoint?.trim();
  if (!source) throw new Error("Source endpoint is required");
  const credential = input.credential?.trim() || undefined;
  if (preset.credential === "required" && !credential)
    throw new Error("This connector requires a credential");
  if (preset.credential === "none" && credential)
    throw new Error("Source preset does not accept a credential");
  return {
    kind: preset.kind,
    name: input.name,
    source,
    config: structuredClone(preset.config),
    credential,
  };
}

/** Older native clients sent this persisted preset selector inside their MCP config. */
export function resolveLegacySourceConfig(
  kind: string,
  source: string,
  config: Record<string, unknown>,
) {
  if (kind !== "mcp" || config.preset !== "treg") return { source, config };
  return {
    source: "https://treg.to/mcp/",
    config: { ...config, preset: "treg", auth: { type: "bearer" } },
  };
}
