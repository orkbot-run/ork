// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterEach, expect, it, vi } from "vitest";
import { modelConnectionMetadata } from "./model-connection-metadata.js";
import {
  assertModelProviderAllowed,
  filterAllowedModelCatalog,
  isModelEndpointAllowed,
  isModelProviderAllowed,
  ModelProviderBlockedError,
} from "./model-provider-policy.js";

afterEach(() => vi.unstubAllEnvs());

const env = "ORKBOT_MODEL_PROVIDER_ALLOWLIST";
const compatible = "openai-compatible";
const catalog = [
  { provider: "anthropic", id: "standard" },
  { provider: compatible, id: "custom", connection: modelConnectionMetadata(compatible) },
];

it("preserves the original behavior and catalog when unset or blank", () => {
  for (const value of [undefined, "  "]) {
    vi.stubEnv(env, value);
    expect(filterAllowedModelCatalog(catalog)).toBe(catalog);
    expect(isModelEndpointAllowed(compatible, "https://ollama.com/v1")).toBe(true);
    expect(isModelProviderAllowed("xai")).toBe(true);
  }
});

it("honors comma-separated catalog IDs, Azure aliases, and live policy reads", () => {
  vi.stubEnv(env, " Anthropic , azure-openai-responses ");
  expect(filterAllowedModelCatalog(catalog)).toEqual([catalog[0]]);
  expect(isModelProviderAllowed("azure")).toBe(true);
  expect(() => assertModelProviderAllowed("openrouter")).toThrow(ModelProviderBlockedError);
  vi.stubEnv(env, "openrouter");
  expect(isModelProviderAllowed("openrouter")).toBe(true);
  expect(isModelProviderAllowed("anthropic")).toBe(false);
});

it("keeps the preset policy attached to the hostname across ports and paths", () => {
  vi.stubEnv(env, compatible);
  expect(isModelEndpointAllowed(compatible, "https://local.example/v1")).toBe(true);
  expect(isModelEndpointAllowed(compatible, "https://OLLAMA.com.:8443/custom")).toBe(false);
  expect(filterAllowedModelCatalog(catalog)[0]?.connection).toMatchObject({
    customEndpointAllowed: true,
    presets: [],
  });
  vi.stubEnv(env, "ollama-cloud");
  expect(isModelProviderAllowed(compatible)).toBe(true);
  expect(isModelEndpointAllowed(compatible)).toBe(false);
  expect(isModelEndpointAllowed(compatible, "https://ollama.com/v1")).toBe(true);
  expect(isModelEndpointAllowed(compatible, "https://ollama.com.example/v1")).toBe(false);
  expect(filterAllowedModelCatalog(catalog)[0]?.connection).toMatchObject({
    customEndpointAllowed: false,
    presets: [{ id: "ollama-cloud" }],
  });
  expect(
    filterAllowedModelCatalog([{ provider: compatible, connection: undefined }])[0],
  ).toMatchObject({
    connection: { customEndpointAllowed: false, presets: [{ id: "ollama-cloud" }] },
  });
});
