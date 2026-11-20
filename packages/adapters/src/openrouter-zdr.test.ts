// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Api, Model, Models, ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { normalizeRunError } from "@orkbot/core";
import { describe, expect, it, vi } from "vitest";
import { modelFromAIConnection } from "./ai-connection-model.js";
import { HttpDecisionProvider } from "./http-decisions.js";
import { OPENROUTER_ZDR_UNAVAILABLE, openRouterZdrFetch } from "./openrouter-zdr.js";
import { resolveRuntimeModel } from "./pi-runtime-models.js";
import { reliableModelStream } from "./pi-runtime-stream.js";

const choice = { provider: "openrouter", modelId: "fixture/model" };

describe("OpenRouter Zero Data Retention", () => {
  it("preserves connection policy through server/workspace translation without changing the catalog", () => {
    const config = modelFromAIConnection(
      choice,
      {
        kind: "api_key",
        key: "fake",
        zeroDataRetention: true,
        contextWindow: 8192,
      },
      "fake",
    );
    expect(config.zeroDataRetention).toBe(true);
    const privateModel = resolveRuntimeModel(config).model;
    expect(privateModel).toMatchObject({ zeroDataRetention: true });
    expect(resolveRuntimeModel({ ...config, zeroDataRetention: false }).model).not.toHaveProperty(
      "zeroDataRetention",
    );
    const catalogConfig = { provider: "openrouter", id: "openai/gpt-5.6-luna" };
    expect(resolveRuntimeModel({ ...catalogConfig, zeroDataRetention: true }).model).toHaveProperty(
      "zeroDataRetention",
      true,
    );
    expect(resolveRuntimeModel(catalogConfig).model).not.toHaveProperty("zeroDataRetention");
  });

  it.each([
    ["openai-completions", openAICompletionsApi],
    ["anthropic-messages", anthropicMessagesApi],
    ["openai-responses", openAIResponsesApi],
  ] as const)(
    "enforces policy on the actual %s SDK request, including retries",
    async (apiName, apiFactory) => {
      const api: ProviderStreams = apiFactory();
      const configured = modelFromAIConnection(
        choice,
        {
          kind: "api_key",
          key: "fake",
          zeroDataRetention: true,
          contextWindow: 8192,
        },
        "fake",
      );
      const model = {
        ...resolveRuntimeModel(configured).model!,
        api: apiName,
        baseUrl:
          apiName === "anthropic-messages"
            ? "https://openrouter.ai/api"
            : "https://openrouter.ai/api/v1",
        reasoning: false,
      } as Model<Api>;
      const bodies: Record<string, unknown>[] = [];
      const transport = vi.fn<typeof fetch>(async (input, init) => {
        const sent = new Request(input, init);
        expect(new URL(sent.url).pathname).toBe(
          apiName === "anthropic-messages"
            ? "/api/v1/messages"
            : apiName === "openai-responses"
              ? "/api/v1/responses"
              : "/api/v1/chat/completions",
        );
        bodies.push(await sent.json());
        return Response.json(
          {
            error: {
              message: bodies.length === 1 ? "Temporary upstream error" : "End of fixture",
            },
          },
          { status: bodies.length === 1 ? 500 : 400 },
        );
      });
      const stream = reliableModelStream(
        { streamSimple: api.streamSimple } as unknown as Models,
        model,
        {
          messages: [{ role: "user", content: "Hello", timestamp: 0 }],
        },
        {
          apiKey: "fake",
          fetch: transport,
          maxRetries: 1,
          maxRetryDelayMs: 1,
          onPayload: (body) => ({
            ...(body as object),
            provider: {
              order: ["anthropic"],
              allow_fallbacks: true,
              zdr: false,
              data_collection: "allow",
            },
          }),
        },
        undefined,
      );
      const result = await stream.result();
      expect(bodies, result.errorMessage).toHaveLength(2);
      for (const body of bodies)
        expect(body.provider).toEqual({
          order: ["anthropic"],
          allow_fallbacks: true,
          zdr: true,
          data_collection: "deny",
        });
    },
  );

  it("leaves unselected connections free of ZDR routing restrictions", async () => {
    const api = openAICompletionsApi();
    const config = modelFromAIConnection(
      choice,
      { kind: "api_key", key: "fake", contextWindow: 8192 },
      "fake",
    );
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: { message: "Fixture" } }, { status: 400 }));
    const model = resolveRuntimeModel(config).model!;
    await reliableModelStream(
      { streamSimple: api.streamSimple } as unknown as Models,
      model,
      {
        messages: [{ role: "user", content: "Hello", timestamp: 0 }],
      },
      { apiKey: "fake", fetch: transport, maxRetries: 0 },
      undefined,
    ).result();
    const body = JSON.parse(String(transport.mock.calls[0]?.[1]?.body));
    expect(body.provider?.zdr).not.toBe(true);
    expect(body.provider?.data_collection).not.toBe("deny");
  });

  it("supports Request inputs and preserves routing while overriding weaker privacy settings", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const request = new Request("https://openrouter.ai/api/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer fake" },
      body: JSON.stringify({
        model: "fixture",
        provider: { only: ["anthropic"], sort: "price" },
      }),
    });
    await openRouterZdrFetch(transport)(request);
    const [, init] = transport.mock.calls[0]!;
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body)).provider).toEqual({
      only: ["anthropic"],
      sort: "price",
      zdr: true,
      data_collection: "deny",
    });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake");
    expect(init?.redirect).toBe("error");
  });

  it("labels a rejected privacy filter as model unavailable", async () => {
    const guarded = openRouterZdrFetch(async () =>
      Response.json(
        { error: { message: "No endpoints found matching your data policy." } },
        { status: 404 },
      ),
    );
    const response = await guarded("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });
    const body = await response.json();
    expect(body.error.message).toBe(OPENROUTER_ZDR_UNAVAILABLE);
    expect(normalizeRunError(body.error.message).kind).toBe("model");
  });

  it("rejects unsupported endpoints and Decisions before sending anything", async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(
      openRouterZdrFetch(transport)("https://openrouter.ai/api/alpha/decisions", {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow("cannot enforce");
    expect(
      () =>
        new HttpDecisionProvider("openrouter", {
          apiKey: "fake",
          zeroDataRetention: true,
          fetch: transport,
        }),
    ).toThrow(expect.objectContaining({ kind: "model_unavailable" }));
    expect(() =>
      resolveRuntimeModel({
        provider: "openrouter",
        id: "typesafe/jev-1.14",
        zeroDataRetention: true,
      }),
    ).toThrow("Decisions cannot enforce OpenRouter");
    expect(transport).not.toHaveBeenCalled();
  });
});
