// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type {
  ModelConnectInput,
  ModelConnectionMetadata,
  ModelConnectionPreset,
  ModelRoutingValues,
} from "@orkbot/contracts";
import {
  compatibleEndpointPreset,
  ModelConnectionMetadataSchema,
  ModelRoutingValueSchema,
  modelEndpointIdentity,
  normalizeModelRouting,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@orkbot/contracts";

import {
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
  CLOUDFLARE_WORKERS_AI_PROVIDER_ID,
  cloudflareModelConfigMessage,
} from "./cloudflare-model-config.js";

type LegacyRoutingKey = "accountId" | "gatewayId";
type RoutingRecord = { routing?: ModelRoutingValues; accountId?: string; gatewayId?: string };
type ConnectionDefinition = {
  metadata: ModelConnectionMetadata;
  legacy?: Readonly<Record<string, LegacyRoutingKey>>;
  invalidRoutingMessage?: string;
};

/** One preset per effective endpoint; host/port/slash spelling does not create another row. */
export function dedupeModelConnectionPresets(
  presets: readonly ModelConnectionPreset[],
): ModelConnectionPreset[] {
  const unique = new Map<string, ModelConnectionPreset>();
  for (const preset of presets) {
    const identity = modelEndpointIdentity(preset.baseUrl);
    if (!unique.has(identity)) unique.set(identity, { ...preset, baseUrl: identity });
  }
  return [...unique.values()];
}

const definitions: Readonly<Record<string, ConnectionDefinition>> = {
  [CLOUDFLARE_AI_GATEWAY_PROVIDER_ID]: {
    metadata: {
      routingFields: [
        { key: "account", label: "Account ID", required: true },
        { key: "gateway", label: "Gateway ID", required: true },
      ],
    },
    legacy: { account: "accountId", gateway: "gatewayId" },
    invalidRoutingMessage: cloudflareModelConfigMessage(CLOUDFLARE_AI_GATEWAY_PROVIDER_ID),
  },
  [CLOUDFLARE_WORKERS_AI_PROVIDER_ID]: {
    metadata: { routingFields: [{ key: "account", label: "Account ID", required: true }] },
    legacy: { account: "accountId" },
    invalidRoutingMessage: cloudflareModelConfigMessage(CLOUDFLARE_WORKERS_AI_PROVIDER_ID),
  },
  [OPENAI_COMPATIBLE_PROVIDER_ID]: {
    metadata: {
      presets: dedupeModelConnectionPresets([
        {
          label: "Ollama Cloud",
          baseUrl: "https://ollama.com/v1",
          apiProtocol: "chat-completions",
          apiKeyRequired: true,
        },
      ]),
    },
  },
};

function definitionFor(provider: string): ConnectionDefinition | undefined {
  return Object.hasOwn(definitions, provider) ? definitions[provider] : undefined;
}

export function modelConnectionMetadata(provider: string): ModelConnectionMetadata | undefined {
  const definition = definitionFor(provider);
  return definition ? ModelConnectionMetadataSchema.parse(definition.metadata) : undefined;
}

/** Project old records into generic form fields without discarding a valid partial route. */
export function modelCredentialRouting(
  provider: string,
  record: RoutingRecord,
): ModelRoutingValues | undefined {
  const definition = definitionFor(provider);
  if (!definition?.metadata.routingFields?.length) return undefined;
  return Object.fromEntries(
    definition.metadata.routingFields.flatMap(({ key }) => {
      const legacyKey = definition.legacy?.[key];
      const value =
        record.routing !== undefined
          ? record.routing[key]
          : legacyKey
            ? record[legacyKey]
            : undefined;
      const parsed = ModelRoutingValueSchema.safeParse(value);
      return parsed.success ? [[key, parsed.data]] : [];
    }),
  );
}

function routingFields(
  definition: ConnectionDefinition | undefined,
  routing: ModelRoutingValues,
): RoutingRecord {
  return {
    routing,
    ...Object.fromEntries(
      Object.entries(definition?.legacy ?? {}).flatMap(([key, legacyKey]) =>
        routing[key] ? [[legacyKey, routing[key]]] : [],
      ),
    ),
  };
}

/** Old and new clients see the same target, including when an incomplete route needs repair. */
export function modelCredentialRoutingFields(
  provider: string,
  record: RoutingRecord,
): RoutingRecord {
  const routing = modelCredentialRouting(provider, record);
  if (routing !== undefined) return routingFields(definitionFor(provider), routing);
  return {
    ...(record.accountId ? { accountId: record.accountId } : {}),
    ...(record.gatewayId ? { gatewayId: record.gatewayId } : {}),
  };
}

/** Metadata is authoritative here even when a client omits or replaces its catalog metadata. */
export function modelConnectionRouting(
  input: Pick<ModelConnectInput, "provider" | "routing" | "accountId" | "gatewayId">,
  previous?: RoutingRecord,
): RoutingRecord | undefined {
  const definition = definitionFor(input.provider);
  const fields = definition?.metadata.routingFields ?? [];
  if (!fields.length) {
    if (input.routing && Object.keys(input.routing).length)
      throw new Error("Invalid model connection");
    return undefined;
  }
  const legacyInput = Object.fromEntries(
    Object.entries(definition!.legacy ?? {}).flatMap(([key, legacyKey]) =>
      input[legacyKey] !== undefined ? [[key, input[legacyKey]!]] : [],
    ),
  );
  if (
    input.routing !== undefined &&
    Object.entries(legacyInput).some(
      ([key, value]) => input.routing?.[key]?.trim() !== value.trim(),
    )
  )
    throw new Error("Invalid model connection");
  const values = input.routing ?? {
    ...(previous ? modelCredentialRouting(input.provider, previous) : {}),
    ...legacyInput,
  };
  const routing = normalizeModelRouting(fields, values);
  if (!routing) throw new Error(definition?.invalidRoutingMessage ?? "Invalid model connection");
  return routingFields(definition, routing);
}

export function assertCompatiblePresetApiKey(baseUrl: string, apiKey: string | undefined): void {
  const presets = definitions[OPENAI_COMPATIBLE_PROVIDER_ID]?.metadata.presets;
  if (compatibleEndpointPreset(baseUrl, presets)?.apiKeyRequired && !apiKey?.trim())
    throw new Error("This endpoint requires an API key.");
}
