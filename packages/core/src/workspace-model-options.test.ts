// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it } from "vitest";
import { workspaceApiModels, workspaceApiProviders } from "./workspace-model-options.js";

it("uses the same app catalog while excluding account-only and non-chat models", () => {
  const entry = {
    provider: "example",
    providerName: "Example",
    billing: "API",
    auth: "api-key" as const,
  };
  const catalog = [
    { ...entry, id: "model-one", label: "Model One" },
    { ...entry, id: "model-two", label: "Model Two" },
    {
      ...entry,
      provider: "subscription",
      id: "account-only",
      label: "Account",
      auth: "oauth" as const,
    },
    { ...entry, id: "review-only", label: "Review", protocol: "decisions" as const },
    { ...entry, provider: "openai-compatible", id: "custom", label: "Custom", placeholder: true },
  ];
  expect(workspaceApiProviders(catalog).map((provider) => provider.id)).toEqual([
    "example",
    "openai-compatible",
  ]);
  expect(workspaceApiModels(catalog, "example").map((model) => model.id)).toEqual([
    "model-one",
    "model-two",
  ]);
  expect(workspaceApiModels(catalog, "subscription")).toEqual([]);
  expect(workspaceApiModels(catalog, "openai-compatible")).toEqual([]);
});
