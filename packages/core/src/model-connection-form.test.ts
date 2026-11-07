// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; model configuration changes follow LICENSE.md.

import type { ModelCredential } from "@orkbot/contracts";
import { describe, expect, it } from "vitest";
import type { ConnectionFormDraft } from "./model-connection-form.js";
import {
  compatibleConnectionReady,
  connectionFormFields,
  connectionFormModelId,
  createConnectionFormState,
  hasModelConnection,
  modelConnectionOptions,
  modelConnectRequest,
} from "./model-connection-form.js";

const catalog = [
  {
    provider: "anthropic",
    id: "opus",
    thinkingLevels: ["low", "high"] as ModelCredential["thinkingLevels"],
  },
  { provider: "anthropic", id: "sonnet", recommended: true },
  { provider: "openrouter", id: "jev" },
];
const COMPATIBLE = "openai-compatible";

function credential(overrides: Partial<ModelCredential> = {}): ModelCredential {
  return {
    id: "credential-fixture",
    provider: "anthropic",
    label: "Anthropic",
    hasKey: true,
    isDefault: true,
    ...overrides,
  };
}

function draft(overrides: Partial<ConnectionFormDraft> = {}): ConnectionFormDraft {
  return {
    apiKey: "",
    modelId: "",
    enabledModelIds: [],
    baseUrl: "",
    apiProtocol: "chat-completions",
    headerRows: null,
    reasoning: false,
    thinkingLevel: null,
    maxTokens: "",
    contextWindow: "262144",
    supportsImages: false,
    maxImagesPerPrompt: "",
    routing: {},
    ...overrides,
  };
}

describe("connectionFormModelId", () => {
  it("keeps the model on screen while the catalog lists it", () => {
    expect(
      connectionFormModelId({
        catalog,
        provider: "anthropic",
        credential: credential({ modelId: "sonnet" }),
        current: "opus",
      }),
    ).toBe("opus");
  });

  it("falls back to the connection's model, then the default, then the recommended one", () => {
    const defaults = { defaultProvider: "anthropic", defaultModel: "opus" };
    expect(
      connectionFormModelId({
        catalog,
        provider: "anthropic",
        credential: credential({ modelId: "sonnet" }),
        defaults,
        current: "gone",
      }),
    ).toBe("sonnet");
    expect(connectionFormModelId({ catalog, provider: "anthropic", defaults })).toBe("opus");
    expect(
      connectionFormModelId({
        catalog,
        provider: "anthropic",
        defaults: { defaultProvider: "openrouter", defaultModel: "jev" },
      }),
    ).toBe("sonnet");
  });

  it("opens a new OpenAI-compatible connection empty instead of on another server's model", () => {
    const defaults = { defaultProvider: COMPATIBLE, defaultModel: "local-model" };
    expect(connectionFormModelId({ catalog, provider: COMPATIBLE, defaults })).toBe("");
    expect(
      connectionFormModelId({
        catalog,
        provider: COMPATIBLE,
        credential: credential({ provider: COMPATIBLE, modelId: "saved-model" }),
        defaults,
        current: "typed-model",
      }),
    ).toBe("saved-model");
  });
});

describe("connectionFormFields", () => {
  it("fills a new connection with defaults and the endpoint preset", () => {
    expect(
      connectionFormFields({
        catalog,
        provider: COMPATIBLE,
        modelId: "",
        presetBaseUrl: "https://ollama.com/v1",
      }),
    ).toEqual({
      enabledModelIds: [],
      baseUrl: "https://ollama.com/v1",
      apiProtocol: "chat-completions",
      reasoning: false,
      thinkingLevel: null,
      maxTokens: "4096",
      contextWindow: "262144",
      supportsImages: false,
      maxImagesPerPrompt: "",
      routing: {},
    });
  });

  it("shows a saved OpenAI-compatible connection, with effort only for its saved model", () => {
    const saved = credential({
      provider: COMPATIBLE,
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local",
      enabledModelIds: ["local", "other"],
      reasoning: true,
      thinkingLevel: "high",
      maxTokens: 2048,
      contextWindow: 32_000,
      supportsImages: true,
      maxImagesPerPrompt: 4,
    });
    const fields = connectionFormFields({
      catalog,
      provider: COMPATIBLE,
      modelId: "local",
      credential: saved,
      presetBaseUrl: "https://ignored.example/v1",
    });
    expect(fields).toMatchObject({
      enabledModelIds: ["local", "other"],
      baseUrl: "http://127.0.0.1:8000/v1",
      apiProtocol: "chat-completions",
      reasoning: true,
      thinkingLevel: "high",
      maxTokens: "2048",
      contextWindow: "32000",
      supportsImages: true,
      maxImagesPerPrompt: "4",
    });
    expect(
      connectionFormFields({ catalog, provider: COMPATIBLE, modelId: "other", credential: saved })
        .thinkingLevel,
    ).toBeNull();
  });

  it("keeps a saved protocol and clamps its effort levels to what the protocol runs", () => {
    const saved = credential({
      provider: COMPATIBLE,
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local",
      reasoning: true,
      thinkingLevel: "max",
      apiProtocol: "anthropic-messages",
    });
    expect(
      connectionFormFields({ catalog, provider: COMPATIBLE, modelId: "local", credential: saved })
        .apiProtocol,
    ).toBe("anthropic-messages");
    // Anthropic Messages has no budget above high, so a saved max clamps down.
    expect(
      connectionFormFields({ catalog, provider: COMPATIBLE, modelId: "local", credential: saved })
        .thinkingLevel,
    ).toBe("high");
    const request = modelConnectRequest({
      form: draft({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "local",
        apiProtocol: "anthropic-messages",
        reasoning: true,
        thinkingLevel: "xhigh",
        maxTokens: "4096",
      }),
      selected: {
        provider: COMPATIBLE,
        id: "openai-compatible",
        providerName: "OpenAI-compatible",
      },
      credentialId: null,
    });
    expect(request.status === "ready" && request.input).toMatchObject({
      apiProtocol: "anthropic-messages",
      thinkingLevel: "high",
    });
  });

  it("clamps a catalog connection's effort to its model and leaves the endpoint empty", () => {
    const fields = connectionFormFields({
      catalog,
      provider: "anthropic",
      modelId: "opus",
      credential: credential({ modelId: "opus", thinkingLevel: "medium", baseUrl: "x" }),
    });
    expect(fields.thinkingLevel).toBe("high");
    expect(fields.baseUrl).toBe("");
    expect(fields.maxTokens).toBe("");
  });
});

describe("compatibleConnectionReady", () => {
  const ready = { apiKey: "", baseUrl: " http://h/v1 ", modelId: "m", headerRows: null };

  it("needs a URL and a model", () => {
    expect(compatibleConnectionReady(ready)).toBe(true);
    expect(compatibleConnectionReady({ ...ready, modelId: "" })).toBe(false);
    expect(compatibleConnectionReady({ ...ready, baseUrl: " " })).toBe(false);
  });

  it("refuses invalid header rows", () => {
    expect(
      compatibleConnectionReady({ ...ready, headerRows: [{ name: "bad name", value: "v" }] }),
    ).toBe(false);
  });
});

describe("modelConnectRequest", () => {
  const anthropic = {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "opus",
    thinkingLevels: ["low", "high"] as ModelCredential["thinkingLevels"],
  };

  it("waits for a key, or a saved connection for a limits-only save", () => {
    expect(
      modelConnectRequest({
        form: draft({ apiKey: "short" }),
        selected: anthropic,
        credentialId: null,
      }).status,
    ).toBe("incomplete");
    expect(
      modelConnectRequest({ form: draft(), selected: anthropic, credentialId: null }).status,
    ).toBe("incomplete");
  });

  it("names the out-of-range field", () => {
    expect(
      modelConnectRequest({
        form: draft({ apiKey: "sk-long-enough", maxTokens: "0" }),
        selected: anthropic,
        credentialId: null,
      }),
    ).toEqual({ status: "invalid", field: "maxTokens" });
    const compatible = { provider: COMPATIBLE, id: "openai-compatible" };
    const form = draft({ baseUrl: "http://h/v1", modelId: "m", maxTokens: "4096" });
    expect(
      modelConnectRequest({
        form: { ...form, supportsImages: true, maxImagesPerPrompt: "2000" },
        selected: compatible,
        credentialId: null,
      }),
    ).toEqual({ status: "invalid", field: "maxImagesPerPrompt" });
    expect(
      modelConnectRequest({
        form: { ...form, contextWindow: "" },
        selected: compatible,
        credentialId: null,
      }),
    ).toEqual({ status: "invalid", field: "contextWindow" });
  });

  it("connects a catalog key with the clamped effort and the makeDefault target", () => {
    expect(
      modelConnectRequest({
        form: draft({ apiKey: " sk-long-enough ", thinkingLevel: "medium" }),
        selected: anthropic,
        credentialId: null,
        makeDefault: { makeDefault: true, scope: "account" },
      }),
    ).toEqual({
      status: "ready",
      savingLimitOnly: false,
      activeModelId: "opus",
      input: {
        provider: "anthropic",
        apiKey: "sk-long-enough",
        modelId: "opus",
        thinkingLevel: "high",
        makeDefault: true,
        scope: "account",
        maxTokens: null,
        label: "Anthropic",
        credentialId: null,
      },
    });
  });

  it("leaves the stored effort alone on a limits-only save unless model or effort changed", () => {
    const saved = credential({ modelId: "opus", thinkingLevel: "high" });
    const limits = modelConnectRequest({
      form: draft({ apiKey: "sk-ignored-here", maxTokens: "1024", thinkingLevel: "high" }),
      selected: anthropic,
      credential: saved,
      credentialId: saved.id,
      settingsOnly: true,
    });
    expect(limits).toMatchObject({ status: "ready", savingLimitOnly: true });
    expect(limits.status === "ready" && limits.input).toEqual({
      provider: "anthropic",
      modelId: "opus",
      maxTokens: 1024,
      label: "Anthropic",
      credentialId: saved.id,
    });
    const effort = modelConnectRequest({
      form: draft({ thinkingLevel: "low" }),
      selected: anthropic,
      credential: saved,
      credentialId: saved.id,
    });
    expect(effort.status === "ready" && effort.input.thinkingLevel).toBe("low");
    const model = modelConnectRequest({
      form: draft(),
      selected: anthropic,
      credential: credential({ modelId: "sonnet" }),
      credentialId: saved.id,
    });
    expect(model.status === "ready" && "thinkingLevel" in model.input).toBe(true);
  });

  it("sends metadata-defined routing segments trimmed", () => {
    const request = modelConnectRequest({
      form: draft({ apiKey: "fixture-long-enough", routing: { tenant: " acct ", route: " gw " } }),
      selected: {
        provider: "routed-fixture",
        id: "model",
        connection: {
          routingFields: [
            { key: "tenant", label: "Tenant", required: true },
            { key: "route", label: "Route", required: true },
          ],
        },
      },
      credentialId: null,
    });
    expect(request.status === "ready" && request.input).toMatchObject({
      routing: { tenant: "acct", route: "gw" },
    });
  });

  it("saves an OpenAI-compatible connection without repeating its default in the enabled list", () => {
    const request = modelConnectRequest({
      form: draft({
        apiKey: " key ",
        baseUrl: " http://h/v1 ",
        modelId: " m ",
        enabledModelIds: ["m", "n"],
        reasoning: true,
        thinkingLevel: "high",
        maxTokens: "4096",
        supportsImages: true,
        headerRows: [{ name: " X-Team ", value: "v" }],
      }),
      selected: {
        provider: COMPATIBLE,
        id: "openai-compatible",
        providerName: "OpenAI-compatible",
      },
      credentialId: "credential-fixture",
    });
    expect(request).toEqual({
      status: "ready",
      savingLimitOnly: false,
      activeModelId: "m",
      input: {
        provider: COMPATIBLE,
        baseUrl: "http://h/v1",
        apiProtocol: "chat-completions",
        headers: { "X-Team": "v" },
        modelId: "m",
        enabledModelIds: ["n"],
        reasoning: true,
        thinkingLevel: "high",
        maxTokens: 4096,
        contextWindow: 262_144,
        supportsImages: true,
        maxImagesPerPrompt: null,
        apiKey: "key",
        label: "OpenAI-compatible",
        credentialId: "credential-fixture",
      },
    });
  });
});

describe("connection catalog and attempt ownership", () => {
  it("uses server presets, normalizes endpoint identity and preserves query distinctions", () => {
    const entry = {
      provider: COMPATIBLE,
      providerName: "Compatible",
      id: "",
      label: "Custom",
      billing: "API key",
      connection: {
        presets: [
          {
            label: "Remote",
            baseUrl: "https://models.example.test/v1",
            apiProtocol: "responses" as const,
          },
          { label: "Duplicate", baseUrl: "https://MODELS.example.test:443/v1/" },
          { label: "Other tenant", baseUrl: "https://models.example.test/v1?tenant=other" },
        ],
      },
    };
    const options = modelConnectionOptions([entry, { ...entry, id: "another" }]);
    expect(options).toHaveLength(3);
    const preset = options.find((option) => option.name === "Remote")!;
    expect(preset.apiProtocol).toBe("responses");
    expect(
      hasModelConnection(preset, [
        { provider: COMPATIBLE, baseUrl: "https://models.example.test/v1/" },
      ]),
    ).toBe(true);
    expect(
      hasModelConnection(preset, [
        { provider: COMPATIBLE, baseUrl: "https://models.example.test/v1?tenant=other" },
      ]),
    ).toBe(false);
    expect(hasModelConnection(preset, [{ provider: "other", baseUrl: preset.baseUrl }])).toBe(
      false,
    );
  });

  it("keeps an edited selected form owned but retires every previous selection permanently", () => {
    let active = true;
    const form = createConnectionFormState(() => active);
    const accepted = form.capture();
    form.invalidate();
    expect(accepted.isSelected()).toBe(true);
    expect(accepted.isCurrent()).toBe(false);
    form.select();
    const next = form.capture();
    expect(accepted.isSelected()).toBe(false);
    expect(next.isCurrent()).toBe(true);
    active = false;
    expect(next.isSelected()).toBe(false);
  });

  it.each(["chat-completions", "responses", "anthropic-messages"] as const)(
    "preserves %s in the same native connection payload",
    (apiProtocol) => {
      const result = modelConnectRequest({
        form: draft({
          apiKey: "fixture-key",
          modelId: "model-x",
          baseUrl: "https://models.example.test/v1",
          apiProtocol,
          maxTokens: "1000",
        }),
        selected: { provider: COMPATIBLE, id: "", providerName: "Compatible" },
        credentialId: null,
        makeDefault: { makeDefault: true, scope: "account" },
      });
      expect(result.status).toBe("ready");
      if (result.status === "ready")
        expect(result.input).toMatchObject({
          apiProtocol,
          modelId: "model-x",
          makeDefault: true,
          scope: "account",
        });
    },
  );
});

const invalidRoutingValues: Record<string, string>[] = [
  {},
  { tenant: "one" },
  { tenant: "one", route: "two", unknown: "three" },
  { tenant: "one/other", route: "two" },
];
it.each(invalidRoutingValues)(
  "refuses incomplete or unsafe adapter routing before a connection can be submitted: %j",
  (routing) => {
    expect(
      modelConnectRequest({
        form: draft({ apiKey: "fixture-key", routing }),
        selected: {
          provider: "routed-fixture",
          id: "model",
          connection: {
            routingFields: [
              { key: "tenant", label: "Tenant", required: true },
              { key: "route", label: "Route", required: true },
            ],
          },
        },
        credentialId: null,
      }),
    ).toEqual({ status: "incomplete" });
  },
);

it("renders required-key policy entirely from catalog metadata and only reuses a key at its saved endpoint", () => {
  const connection = {
    presets: [
      { label: "Remote fixture", baseUrl: "https://remote.example.test/v1", apiKeyRequired: true },
    ],
  };
  const input = {
    apiKey: "",
    baseUrl: "https://REMOTE.example.test:443/v1/",
    modelId: "model",
    headerRows: null,
    connection,
  };
  expect(compatibleConnectionReady(input)).toBe(false);
  expect(
    compatibleConnectionReady({
      ...input,
      credential: { hasKey: true, baseUrl: "https://remote.example.test/v1" },
    }),
  ).toBe(true);
  expect(
    compatibleConnectionReady({
      ...input,
      credential: { hasKey: true, baseUrl: "https://other.example.test/v1" },
    }),
  ).toBe(false);
  expect(compatibleConnectionReady({ ...input, baseUrl: "http://127.0.0.1:8080/v1" })).toBe(true);
});
