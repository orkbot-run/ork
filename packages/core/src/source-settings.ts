// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { RpcInput, SourcePreset } from "@orkbot/contracts";

export type SourceKind = "mcp" | "api" | "graphql";
export type SourceAuth = { type: "none" | "bearer" | "header"; name?: string };

/** Both native clients submit the same declared intent; the server resolves preset policy. */
export function sourceInstallIntent(input: {
  kind: SourceKind;
  presetId: string | null;
  presets: readonly SourcePreset[];
  name: string;
  endpoint: string;
  credential: string;
  auth: SourceAuth;
}): RpcInput<"capabilities/install"> {
  if (input.presetId !== null) {
    const preset = input.presets.find((candidate) => candidate.id === input.presetId);
    if (!preset) throw new Error("Source preset is not available");
    return {
      presetId: preset.id,
      name: input.name.trim() || preset.label,
      ...(preset.endpoint === "input" ? { endpoint: input.endpoint.trim() } : {}),
      ...(preset.credential !== "none" ? { credential: input.credential.trim() || undefined } : {}),
    };
  }
  const auth =
    input.auth.type === "header"
      ? { type: "header", name: input.auth.name?.trim() }
      : { type: input.auth.type };
  return {
    kind: input.kind,
    name: input.name.trim(),
    source: input.endpoint.trim(),
    credential: input.auth.type === "none" ? undefined : input.credential.trim() || undefined,
    config:
      input.kind === "api"
        ? { openApi: true, auth }
        : input.kind === "graphql"
          ? { auth }
          : { preset: "custom", auth },
  };
}
