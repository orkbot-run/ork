// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 role assertions are preserved; synthetic catalog fixtures follow LICENSE.md.

import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { applyPiModelCompatibility } from "./pi-model-compat.js";

// Observed: 400 "minijinja: rendering failed: raise_exception: Unexpected message role."
// Qwen-style chat templates only render system, user, assistant and tool.
it.each(["groq", "xiaomi", "fixture-provider"])(
  "sends system instructions to the %s chat template",
  async (provider) => {
    const id = "fixture-reasoning";
    const models = createModels();
    models.setProvider(
      createProvider({
        id: provider,
        auth: {
          apiKey: {
            name: "Fixture",
            resolve: async () => ({ auth: { apiKey: "fixture-key" }, source: "Fixture" }),
          },
        },
        api: openAICompletionsApi(),
        models: [
          {
            provider,
            id,
            name: id,
            api: "openai-completions",
            baseUrl: "https://models.example.test/v1",
            reasoning: true,
            input: ["text"],
            contextWindow: 4096,
            maxTokens: 128,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      }),
    );
    applyPiModelCompatibility(models);
    const model = models.getModel(provider, id)!;
    expect(model.compat).toMatchObject({ supportsDeveloperRole: false });
    let roles: string[] = [];
    const result = await models
      .streamSimple(
        model,
        {
          systemPrompt: "Fixture instructions.",
          messages: [{ role: "user", content: "Fixture request.", timestamp: 1 }],
        },
        {
          apiKey: "fixture-key",
          reasoning: "low",
          maxRetries: 0,
          fetch: async (_input, init) => {
            const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> };
            roles = body.messages.map((message) => message.role);
            return new Response(
              'data: {"choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        },
      )
      .result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(roles).toEqual(["system", "user"]);
  },
);

describe("provider compatibility boundaries", () => {
  it("keeps other providers unchanged", () => {
    const original = builtinModels();
    const openai = original.getProvider("openai");
    expect(openai).toBeDefined();
    expect(applyPiModelCompatibility(original).getProvider("openai")).toBe(openai);
  });
});
