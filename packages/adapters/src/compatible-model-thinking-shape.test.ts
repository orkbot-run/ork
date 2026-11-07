// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { createModels, createProvider, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelApiProtocol } from "@orkbot/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { buildModelConnectPlaintext, modelCredentialDto } from "./model-connect.js";
import { compatibleThinkingLevels } from "./model-selection.js";
import { parseModelSecret, serializeModelSecret } from "./pi-oauth.js";
import {
  openAiCompatibleModel,
  registerOpenAiCompatibleRuntime,
} from "./pi-openai-compatible-provider.js";
import { resolveRuntimeModel, thinkingLevelFor } from "./pi-runtime-models.js";
import { resolveModelKey } from "./run-model.js";

const fixtureCatalog = vi.hoisted(() => ({ models: undefined as MutableModels | undefined }));
vi.mock("@earendil-works/pi-ai/providers/all", async (importOriginal) => {
  const original = await importOriginal<{ builtinModels: typeof builtinModels }>();
  return {
    ...original,
    builtinModels: (...args: Parameters<typeof builtinModels>) =>
      fixtureCatalog.models ?? original.builtinModels(...args),
  };
});

const id = "fiction-thinker";
const baseUrl = "http://127.0.0.1:8090/v1";

function known<T extends Api>(api: T, overrides: Partial<Model<T>> = {}): Model<T> {
  return {
    provider: `fixture-${api}`,
    id,
    name: "Catalog name",
    api,
    baseUrl: "https://catalog.example.test/v1",
    reasoning: true,
    input: ["text"],
    contextWindow: 4096,
    maxTokens: 128,
    cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    ...overrides,
  };
}

function configured(
  candidates: Model<Api>[],
  apiProtocol: ModelApiProtocol = "chat-completions",
  reasoning = true,
) {
  const models = createModels();
  for (const candidate of candidates)
    models.setProvider(
      createProvider({
        id: candidate.provider,
        auth: {},
        api: openAICompletionsApi(),
        models: [candidate],
      }),
    );
  registerOpenAiCompatibleRuntime(models, {
    modelId: id,
    baseUrl,
    apiProtocol,
    reasoning,
    acceptsImages: true,
    maxTokens: 777,
    contextWindow: 8192,
    allowPrivate: true,
  });
  return {
    models,
    model: openAiCompatibleModel(id, baseUrl, reasoning, true, 777, 8192, apiProtocol, models),
  };
}

async function requestBodyFor({ models, model }: ReturnType<typeof configured>) {
  let body: Record<string, unknown> | undefined;
  const result = await models
    .streamSimple(
      model,
      {
        messages: [{ role: "user", content: "Fixture", timestamp: 1 }],
      },
      {
        reasoning: "high",
        maxRetries: 0,
        fetch: async (_input, init) => {
          body = JSON.parse(String(init?.body));
          return Response.json({ error: { message: "Fixture key rejected" } }, { status: 401 });
        },
      },
    )
    .result();
  expect(result.stopReason).toBe("error");
  expect(body).toBeDefined();
  return body!;
}

describe("compatible known-model thinking shape", () => {
  it("keeps saved, legacy, secondary-id validation and runtime effort consistent", async () => {
    const first = known("openai-completions", {
      id: "fiction-high",
      provider: "fixture-high",
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: null,
      },
    });
    const second = known("openai-completions", {
      id: "fiction-low",
      provider: "fixture-low",
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      },
    });
    fixtureCatalog.models = createModels();
    for (const candidate of [first, second])
      fixtureCatalog.models.setProvider(
        createProvider({
          id: candidate.provider,
          auth: {},
          api: openAICompletionsApi(),
          models: [candidate],
        }),
      );
    const input = {
      provider: "openai-compatible",
      modelId: first.id,
      baseUrl,
      reasoning: true,
      thinkingLevel: "max" as const,
      enabledModelIds: [first.id, second.id],
    };
    const saved = buildModelConnectPlaintext(input, undefined, { allowPrivateEndpoint: true });
    expect(parseModelSecret(saved)).toMatchObject({ thinkingLevel: "high" });
    const legacy = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl,
      reasoning: true,
      thinkingLevel: "max",
      enabledModelIds: input.enabledModelIds,
    });
    const row = {
      id: "fixture-credential",
      provider: input.provider,
      label: "Fixture",
      defaultModel: first.id,
    };
    expect(modelCredentialDto(row, legacy)).toMatchObject({
      thinkingLevel: "high",
      thinkingLevels: ["high"],
    });
    expect(compatibleThinkingLevels(row, legacy, second.id).allowed).toEqual(["low"]);
    expect(compatibleThinkingLevels(row, legacy, ` ${second.id} `).allowed).toEqual(["low"]);
    const deps = {
      billingEnabled: false,
      mcpAllowPrivateEndpoint: true,
      prisma: {
        secret: {
          findFirst: async () => ({ id: "fixture-secret", ciphertext: "fixture-ciphertext" }),
        },
      },
      secretStore: { load: async () => legacy },
    } as unknown as ExecutorDeps;
    const resolved = await resolveModelKey(
      deps,
      "fixture-user",
      "fixture-space",
      { ...row, secretId: "fixture-secret" },
      input.provider,
      first.id,
    );
    expect(resolved.thinkingLevel).toBe("high");
    const runtime = resolveRuntimeModel({
      provider: input.provider,
      id: first.id,
      baseUrl,
      reasoning: true,
      thinkingLevel: "max",
      allowPrivateEndpoint: true,
    });
    expect(getSupportedThinkingLevels(runtime.model!)).toEqual(["high"]);
    expect(thinkingLevelFor(runtime.model!, "max")).toBe("high");
    for (const reasoning of [true, false]) {
      const off = buildModelConnectPlaintext(
        { ...input, modelId: "fiction-unknown", reasoning, thinkingLevel: "off" },
        undefined,
        { allowPrivateEndpoint: true },
      );
      expect(parseModelSecret(off)).toMatchObject({ reasoning, thinkingLevel: "off" });
    }
  });

  it("inherits only thinking capabilities and retains the connection's endpoint and limits", () => {
    const { model } = configured([
      known("openai-completions", {
        headers: { "x-catalog-only": "do-not-copy" },
        thinkingLevelMap: { minimal: null, medium: null, high: "high", xhigh: null, max: null },
        compat: {
          thinkingFormat: "qwen-chat-template",
          supportsReasoningEffort: false,
          chatTemplateKwargs: {
            enable_thinking: { $var: "thinking.enabled" },
            catalog_route: "do-not-copy",
          },
          supportsThinkingTokenBudget: true,
          thinkingTokenBudgetField: "thinking_budget",
          requiresReasoningContentOnAssistantMessages: true,
          supportsStore: true,
          supportsDeveloperRole: true,
          openRouterRouting: { only: ["do-not-copy"] },
          sendSessionAffinityHeaders: true,
          supportsLongCacheRetention: true,
          maxTokensField: "max_completion_tokens",
          cacheControlFormat: "anthropic",
        },
      }),
    ]);
    expect(model).toMatchObject({
      provider: "openai-compatible",
      id,
      name: id,
      baseUrl,
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 8192,
      maxTokens: 777,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: { minimal: null, medium: null, high: "high", xhigh: null, max: null },
      compat: {
        thinkingFormat: "qwen-chat-template",
        supportsReasoningEffort: false,
        chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
        supportsThinkingTokenBudget: true,
        thinkingTokenBudgetField: "thinking_budget",
        requiresReasoningContentOnAssistantMessages: true,
        supportsStore: false,
        supportsDeveloperRole: false,
      },
    });
    expect(model.headers).toBeUndefined();
    for (const key of [
      "openRouterRouting",
      "sendSessionAffinityHeaders",
      "supportsLongCacheRetention",
      "maxTokensField",
      "cacheControlFormat",
    ])
      expect(model.compat).not.toHaveProperty(key);
    expect(model.compat).not.toHaveProperty("chatTemplateKwargs.catalog_route");
    expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "high"]);
  });

  it("copies level mapping only from the selected protocol and exact case-sensitive id", () => {
    const otherApi = known("openai-responses", {
      thinkingLevelMap: { off: null, low: null, xhigh: "xhigh" },
    });
    const otherId = known("openai-completions", {
      id: id.toUpperCase(),
      thinkingLevelMap: { off: null, low: null },
    });
    const { model } = configured([otherApi, otherId]);
    expect(model.thinkingLevelMap).toEqual({ off: "none", xhigh: "xhigh", max: "max" });
    expect(getSupportedThinkingLevels(model)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("keeps explicit reasoning off authoritative even for a known id", () => {
    const { model } = configured(
      [
        known("openai-completions", {
          thinkingLevelMap: { off: null, max: "max" },
          compat: { thinkingFormat: "qwen", requiresReasoningContentOnAssistantMessages: true },
        }),
      ],
      "chat-completions",
      false,
    );
    expect(model.reasoning).toBe(false);
    expect(getSupportedThinkingLevels(model)).toEqual(["off"]);
    expect(model.thinkingLevelMap).toEqual({ off: "none" });
    expect(model.compat).not.toHaveProperty("requiresReasoningContentOnAssistantMessages");
    expect(model.compat).toMatchObject({
      thinkingFormat: "openai",
      supportsReasoningEffort: false,
    });
  });

  it("does not guess between conflicting same-id shapes from different catalog providers", () => {
    const first = known("openai-completions", {
      provider: "fixture-first",
      thinkingLevelMap: { max: null },
    });
    const second = known("openai-completions", {
      provider: "fixture-second",
      thinkingLevelMap: { max: "max" },
    });
    expect(configured([first, second]).model.thinkingLevelMap).toEqual({
      off: "none",
      xhigh: "xhigh",
      max: "max",
    });
  });

  it("accepts the same thinking shape across providers while ignoring unrelated differences", () => {
    const first = known("openai-completions", {
      provider: "fixture-first",
      thinkingLevelMap: { max: null },
      compat: { supportsStore: true },
    });
    const second = known("openai-completions", {
      provider: "fixture-second",
      thinkingLevelMap: { max: null },
      compat: { supportsStore: false },
    });
    expect(configured([first, second]).model.thinkingLevelMap).toEqual({ max: null });
  });

  it("uses the known protocol's default levels when its catalog has no extended map", () => {
    const { model } = configured([known("openai-completions")]);
    expect(model.thinkingLevelMap).toBeUndefined();
    expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("never treats a previously configured compatible connection as a catalog authority", () => {
    const run = configured([]);
    run.model.thinkingLevelMap = { off: null, low: null, max: null };
    registerOpenAiCompatibleRuntime(run.models, { modelId: id, baseUrl, reasoning: true });
    expect(run.models.getModel("openai-compatible", id)?.thinkingLevelMap).toEqual({
      off: "none",
      xhigh: "xhigh",
      max: "max",
    });
  });

  it("sends typed thinking template variables without unrelated constant catalog arguments", async () => {
    const body = await requestBodyFor(
      configured([
        known("openai-completions", {
          compat: {
            thinkingFormat: "chat-template",
            supportsReasoningEffort: false,
            chatTemplateKwargs: {
              enable_thinking: { $var: "thinking.enabled" },
              catalog_route: "do-not-copy",
            },
          },
        }),
      ]),
    );
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("keeps Responses thinking maps without inheriting session or cache controls", () => {
    const { model } = configured(
      [
        known("openai-responses", {
          thinkingLevelMap: { off: "none", minimal: null, high: "high", xhigh: null, max: null },
          compat: {
            supportsDeveloperRole: true,
            sessionAffinityFormat: "openrouter",
            supportsLongCacheRetention: true,
            supportsExplicitPromptCacheMode: true,
          },
        }),
      ],
      "responses",
    );
    expect(model.thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      high: "high",
      xhigh: null,
      max: null,
    });
    expect(model.compat).toEqual({ supportsDeveloperRole: false });
  });

  it("keeps Messages adaptive thinking without inheriting unrelated provider behavior", () => {
    const { model } = configured(
      [
        known("anthropic-messages", {
          thinkingLevelMap: { off: null, minimal: null, high: "high", max: "max" },
          compat: {
            forceAdaptiveThinking: true,
            supportsTemperature: false,
            sendSessionAffinityHeaders: true,
            supportsCacheControlOnTools: true,
          },
        }),
      ],
      "anthropic-messages",
    );
    expect(model.thinkingLevelMap).toEqual({ off: null, minimal: null, high: "high", max: "max" });
    expect(model.compat).toEqual({ forceAdaptiveThinking: true });
  });

  it.each(["chat-completions", "responses", "anthropic-messages"] as const)(
    "translates known thinking into the actual %s request",
    async (apiProtocol) => {
      const api =
        apiProtocol === "responses"
          ? "openai-responses"
          : apiProtocol === "anthropic-messages"
            ? "anthropic-messages"
            : "openai-completions";
      const run = configured(
        [
          known(api, {
            thinkingLevelMap: { high: "low", xhigh: null, max: null },
            ...(api === "anthropic-messages" ? { compat: { forceAdaptiveThinking: true } } : {}),
          }),
        ],
        apiProtocol,
      );
      const body = await requestBodyFor(run);
      if (apiProtocol === "chat-completions") expect(body.reasoning_effort).toBe("low");
      else if (apiProtocol === "responses") expect(body.reasoning).toMatchObject({ effort: "low" });
      else {
        expect(body.thinking).toMatchObject({ type: "adaptive" });
        expect(body.output_config).toMatchObject({ effort: "low" });
      }
    },
  );
});
