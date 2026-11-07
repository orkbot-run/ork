// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; model configuration changes follow LICENSE.md.

import type {
  ModelApiProtocol,
  ModelCatalogEntry,
  ModelConnectInput,
  ModelConnectionMetadata,
  ModelCredential,
  ModelHeaderRow,
  SettingsScope,
  ThinkingLevel,
} from "@orkbot/contracts";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  ModelHeaderRowsSchema,
  modelEndpointIdentity,
  modelHeadersInput,
  normalizeModelRouting,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
  savedCompatibleEndpointMatches,
} from "@orkbot/contracts";
import {
  clampCatalogThinkingLevel,
  compatibleThinkingLevels,
  connectionMaxTokensField,
  pickCatalogModelId,
} from "./model-providers.js";

type CatalogModel = Pick<
  ModelCatalogEntry,
  "provider" | "id" | "recommended" | "thinkingLevels" | "connection"
>;
type DefaultModel = { defaultProvider: string | null; defaultModel: string | null };

export type ModelConnectionOption = {
  id: string;
  name: string;
  baseUrl?: string;
  apiProtocol?: ModelApiProtocol;
};

/** Provider rows and endpoint presets come from the same server-owned catalog. */
export function modelConnectionOptions(
  catalog: readonly ModelCatalogEntry[],
): ModelConnectionOption[] {
  const options = new Map<string, ModelConnectionOption>();
  for (const entry of catalog) {
    if (!options.has(entry.provider))
      options.set(entry.provider, {
        id: entry.provider,
        name: entry.providerName ?? entry.provider,
      });
    for (const preset of entry.connection?.presets ?? []) {
      try {
        const key = JSON.stringify([entry.provider, modelEndpointIdentity(preset.baseUrl)]);
        if (!options.has(key))
          options.set(key, {
            id: entry.provider,
            name: preset.label,
            baseUrl: preset.baseUrl,
            ...(preset.apiProtocol ? { apiProtocol: preset.apiProtocol } : {}),
          });
      } catch {
        // An invalid optional preset never hides the provider's generic form.
      }
    }
  }
  return [...options.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function hasModelConnection(
  option: ModelConnectionOption,
  credentials: readonly Pick<ModelCredential, "provider" | "baseUrl">[],
): boolean {
  return credentials.some((credential) => {
    if (credential.provider !== option.id) return false;
    if (!option.baseUrl) return true;
    try {
      return (
        modelEndpointIdentity(option.baseUrl) === modelEndpointIdentity(credential.baseUrl ?? "")
      );
    } catch {
      return false;
    }
  });
}

/** Separate edited fields from switching forms, while every continuation retains its owner. */
export function createConnectionFormState(isActive: () => boolean) {
  let form = 0;
  let edit = 0;
  return {
    invalidate() {
      edit += 1;
    },
    select() {
      form += 1;
      edit += 1;
    },
    capture() {
      const selected = form;
      const revision = edit;
      return {
        isSelected: () => isActive() && selected === form,
        isCurrent: () => isActive() && selected === form && revision === edit,
      };
    },
  };
}

/** What a connection form edits, as the strings and toggles its fields hold. */
export type ConnectionFormFields = {
  enabledModelIds: string[];
  baseUrl: string;
  apiProtocol: ModelApiProtocol;
  reasoning: boolean;
  thinkingLevel: ThinkingLevel | null;
  maxTokens: string;
  contextWindow: string;
  supportsImages: boolean;
  maxImagesPerPrompt: string;
  routing: Record<string, string>;
};

/**
 * The model a connection form opens on. An OpenAI-compatible connection keeps its own model, so
 * a new one starts empty rather than borrowing another server's. A catalog provider keeps the
 * model on screen while the catalog still lists it, else the connection's, else the default's.
 */
export function connectionFormModelId(input: {
  catalog: readonly CatalogModel[];
  provider: string;
  credential?: Pick<ModelCredential, "modelId">;
  defaults?: DefaultModel | null;
  current?: string;
}): string {
  const { catalog, provider, credential, defaults, current } = input;
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID) return credential?.modelId ?? "";
  return (
    catalog.find((entry) => entry.provider === provider && entry.id === current)?.id ??
    pickCatalogModelId(
      catalog,
      provider,
      credential?.modelId ??
        (provider === defaults?.defaultProvider ? defaults.defaultModel : null),
    )
  );
}

/**
 * The fields a form shows for a saved connection, or a new one when `credential` is undefined.
 * A stored effort is bound to the model it was saved with, and is clamped to what `modelId` runs.
 */
export function connectionFormFields(input: {
  catalog: readonly CatalogModel[];
  provider: string;
  modelId: string;
  credential?: Pick<
    ModelCredential,
    | "modelId"
    | "enabledModelIds"
    | "baseUrl"
    | "apiProtocol"
    | "reasoning"
    | "thinkingLevel"
    | "maxTokens"
    | "contextWindow"
    | "supportsImages"
    | "maxImagesPerPrompt"
    | "routing"
  >;
  /** Prefills a new compatible connection from catalog metadata. */
  presetBaseUrl?: string;
  presetApiProtocol?: ModelApiProtocol;
}): ConnectionFormFields {
  const { catalog, provider, modelId, credential, presetBaseUrl } = input;
  const compatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const supportedThinking = compatible
    ? credential?.reasoning
      ? compatibleThinkingLevels(credential?.apiProtocol)
      : []
    : catalog.find((entry) => entry.provider === provider && entry.id === modelId)?.thinkingLevels;
  return {
    enabledModelIds: credential?.enabledModelIds ?? [],
    baseUrl: compatible ? (credential?.baseUrl ?? presetBaseUrl ?? "") : "",
    apiProtocol: credential?.apiProtocol ?? input.presetApiProtocol ?? "chat-completions",
    reasoning: credential?.reasoning ?? false,
    thinkingLevel: clampCatalogThinkingLevel(
      credential?.modelId === modelId ? credential.thinkingLevel : null,
      supportedThinking,
    ) as ThinkingLevel | null,
    maxTokens: connectionMaxTokensField(provider, credential?.maxTokens),
    contextWindow: String(credential?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW),
    supportsImages: credential?.supportsImages ?? false,
    maxImagesPerPrompt: String(credential?.maxImagesPerPrompt ?? ""),
    routing: credential?.routing ?? {},
  };
}

/** Whether an OpenAI-compatible form can save: a URL, a model, valid headers, and a key if one is needed. */
export function compatibleConnectionReady(input: {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  headerRows: ModelHeaderRow[] | null;
  credential?: Pick<ModelCredential, "hasKey" | "baseUrl">;
  connection?: ModelConnectionMetadata;
}): boolean {
  const { apiKey, credential, headerRows, modelId } = input;
  const baseUrl = input.baseUrl.trim();
  const key =
    apiKey ||
    (credential?.hasKey && savedCompatibleEndpointMatches(baseUrl, credential.baseUrl)
      ? "stored"
      : "");
  return Boolean(
    (headerRows === null || ModelHeaderRowsSchema.safeParse(headerRows).success) &&
      openAiCompatibleConnectReady({
        baseUrl,
        modelId,
        apiKey: key,
        presets: input.connection?.presets,
      }),
  );
}

export type ConnectionFormDraft = Omit<ConnectionFormFields, "enabledModelIds"> & {
  apiKey: string;
  modelId: string;
  enabledModelIds: readonly string[];
  headerRows: ModelHeaderRow[] | null;
};

/** A field whose number is out of range; each app words the message. */
export type ConnectionFormInvalidField = "maxTokens" | "maxImagesPerPrompt" | "contextWindow";

export type ModelConnectRequest =
  | { status: "incomplete" }
  | { status: "invalid"; field: ConnectionFormInvalidField }
  | {
      status: "ready";
      input: ModelConnectInput;
      /** A catalog provider's save without a new key: limits and gateway ids only. */
      savingLimitOnly: boolean;
      /** The model the saved connection runs. */
      activeModelId: string;
    };

/**
 * The `models.connect` input for a connection form. `settingsOnly` saves a catalog provider's
 * limits and gateway ids without the key field. `makeDefault` is sent with its scope when set.
 */
export function modelConnectRequest(input: {
  form: ConnectionFormDraft;
  selected: Pick<
    ModelCatalogEntry,
    "provider" | "providerName" | "id" | "thinkingLevels" | "connection"
  >;
  credential?: Pick<ModelCredential, "modelId" | "thinkingLevel" | "hasKey" | "baseUrl">;
  credentialId: string | null;
  settingsOnly?: boolean;
  makeDefault?: { makeDefault: boolean; scope: SettingsScope };
}): ModelConnectRequest {
  const { form, selected, credential, credentialId, settingsOnly = false, makeDefault } = input;
  const compatible = selected.provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const baseUrl = form.baseUrl.trim();
  const modelId = form.modelId.trim();
  const newKey = settingsOnly ? "" : form.apiKey.trim();
  const savingLimitOnly = !compatible && !newKey;
  const activeModelId = compatible ? modelId : selected.id;
  const routing = normalizeModelRouting(selected.connection?.routingFields ?? [], form.routing);
  if (
    !routing ||
    (form.headerRows !== null && !ModelHeaderRowsSchema.safeParse(form.headerRows).success)
  )
    return { status: "incomplete" };
  if (compatible) {
    if (!compatibleConnectionReady({ ...form, credential, connection: selected.connection }))
      return { status: "incomplete" };
  } else if (savingLimitOnly) {
    if (!credential) return { status: "incomplete" };
  } else if (newKey.length < 8) {
    return { status: "incomplete" };
  }
  const maxTokens = form.maxTokens.trim() ? parseModelMaxTokens(form.maxTokens) : undefined;
  if ((compatible || form.maxTokens.trim()) && maxTokens === undefined) {
    return { status: "invalid", field: "maxTokens" };
  }
  const maxImagesPerPrompt = compatible
    ? parseModelMaxImagesPerPrompt(form.maxImagesPerPrompt, form.supportsImages)
    : undefined;
  if (
    compatible &&
    form.supportsImages &&
    form.maxImagesPerPrompt.trim() &&
    maxImagesPerPrompt === undefined
  ) {
    return { status: "invalid", field: "maxImagesPerPrompt" };
  }
  const contextWindow = compatible ? parseModelContextWindow(form.contextWindow) : undefined;
  if (compatible && contextWindow === undefined) {
    return { status: "invalid", field: "contextWindow" };
  }
  // The staged effort belongs to the model on screen. Clamp it before a connect or a limit
  // save so a previous model's level cannot stick.
  const thinkingLevel = clampCatalogThinkingLevel(
    form.thinkingLevel,
    compatible
      ? form.reasoning
        ? compatibleThinkingLevels(form.apiProtocol)
        : []
      : selected.thinkingLevels,
  ) as ThinkingLevel | null;
  const label = selected.providerName ?? selected.provider;
  if (compatible) {
    return {
      status: "ready",
      savingLimitOnly,
      activeModelId,
      input: {
        provider: selected.provider,
        baseUrl,
        apiProtocol: form.apiProtocol,
        headers: modelHeadersInput(form.headerRows),
        modelId,
        // The server adds the default itself.
        enabledModelIds: form.enabledModelIds.filter((id) => id !== modelId),
        reasoning: form.reasoning,
        thinkingLevel,
        maxTokens,
        contextWindow,
        supportsImages: form.supportsImages,
        maxImagesPerPrompt:
          form.supportsImages && !form.maxImagesPerPrompt.trim() ? null : maxImagesPerPrompt,
        ...makeDefault,
        apiKey: form.apiKey.trim() || undefined,
        label,
        credentialId,
        ...(selected.connection?.routingFields?.length ? { routing } : {}),
      },
    };
  }
  const modelChanged = (credential?.modelId ?? null) !== (activeModelId || null);
  const storedThinking =
    credential?.modelId === selected.id ? (credential.thinkingLevel ?? null) : null;
  return {
    status: "ready",
    savingLimitOnly,
    activeModelId,
    input: {
      provider: selected.provider,
      ...(newKey ? { apiKey: newKey } : {}),
      ...(selected.connection?.routingFields?.length ? { routing } : {}),
      modelId: selected.id,
      // A limits-only save leaves the stored effort alone while the model and effort stay
      // put. Changing either sends the clamped level, including null, so the previous
      // model's effort is not reused.
      ...(!savingLimitOnly || modelChanged || (form.thinkingLevel ?? null) !== storedThinking
        ? { thinkingLevel }
        : {}),
      ...makeDefault,
      maxTokens: maxTokens ?? null,
      label,
      credentialId,
    },
  };
}
