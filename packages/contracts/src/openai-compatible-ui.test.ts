// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 URL tests are preserved; neutral preset tests follow LICENSE.md.

import { describe, expect, it } from "vitest";
import {
  compatibleConnectionName,
  normalizeOpenAiCompatibleBaseUrl,
  openAiCompatibleConnectReady,
  savedCompatibleEndpointMatches,
} from "./openai-compatible-ui.js";

describe("openAiCompatibleConnectReady", () => {
  it("allows a new connection with base URL and explicit model id", () => {
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "qwen",
      }),
    ).toBe(true);
  });

  it("rejects empty base URL or model id", () => {
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "  ",
        modelId: "qwen",
      }),
    ).toBe(false);
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "",
      }),
    ).toBe(false);
  });
});

describe("normalizeOpenAiCompatibleBaseUrl", () => {
  it("drops trailing slashes and adds /v1 only when no version is present", () => {
    expect(normalizeOpenAiCompatibleBaseUrl(" http://127.0.0.1:8000/ ")).toBe(
      "http://127.0.0.1:8000/v1",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("https://open.bigmodel.cn/api/paas/v4/")).toBe(
      "https://open.bigmodel.cn/api/paas/v4",
    );
  });

  it("keeps gateway paths that already contain a version segment", () => {
    expect(normalizeOpenAiCompatibleBaseUrl("https://gateway.example.test/v1/some-model")).toBe(
      "https://gateway.example.test/v1/some-model",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("https://gateway.example.test/v1beta/openai/")).toBe(
      "https://gateway.example.test/v1beta/openai",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("https://gateway.example.test/openai")).toBe(
      "https://gateway.example.test/openai/v1",
    );
  });

  it("rejects text that is not an HTTP(S) URL", () => {
    expect(() => normalizeOpenAiCompatibleBaseUrl("127.0.0.1:8000")).toThrow();
  });
});

it("names and validates an ordinary compatible preset using only catalog metadata", () => {
  const preset = {
    label: "Example service",
    baseUrl: "https://models.example.test/v1",
    apiKeyRequired: true,
  };
  expect(compatibleConnectionName(preset.baseUrl, "Compatible", [preset])).toBe(preset.label);
  expect(compatibleConnectionName("https://other.test/v1", "Compatible", [preset])).toBe(
    "Compatible",
  );
  expect(compatibleConnectionName(preset.baseUrl, "Compatible")).toBe("Compatible");
  const input = { baseUrl: preset.baseUrl, modelId: "example-model", presets: [preset] };
  expect(openAiCompatibleConnectReady(input)).toBe(false);
  expect(openAiCompatibleConnectReady({ ...input, apiKey: "fake-key" })).toBe(true);
  expect(openAiCompatibleConnectReady({ ...input, presets: [] })).toBe(true);
});

it.each(["https://models.example.test", "https://models.example.test/v1/"])(
  "matches equivalent saved endpoints: %s",
  (baseUrl) => {
    expect(savedCompatibleEndpointMatches(baseUrl, "https://models.example.test/v1")).toBe(true);
  },
);
it.each(["", "https://", "https://other.test", "https://models.example.test/v2"])(
  "does not inherit credentials for %s",
  (baseUrl) => {
    expect(savedCompatibleEndpointMatches(baseUrl, "https://models.example.test/v1")).toBe(false);
  },
);
it("does not match a missing saved endpoint", () => {
  expect(savedCompatibleEndpointMatches("https://models.example.test/v1", undefined)).toBe(false);
});
