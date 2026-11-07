// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { SourcePreset } from "@orkbot/contracts";
import { describe, expect, it } from "vitest";
import { sourceInstallIntent } from "./source-settings.js";

const preset: SourcePreset = {
  id: "fixture",
  label: "Fixture",
  kind: "mcp",
  endpoint: "fixed",
  credential: "required",
};
const draft = {
  kind: "mcp" as const,
  presetId: null,
  presets: [preset],
  name: " Mine ",
  endpoint: " https://custom.example.test/mcp ",
  credential: " fake-token ",
  auth: { type: "header" as const, name: " x-key " },
};
describe("shared native source install intent", () => {
  it("submits only declared preset inputs, never the custom URL or auth draft", () => {
    expect(sourceInstallIntent({ ...draft, presetId: preset.id })).toEqual({
      presetId: preset.id,
      name: "Mine",
      credential: "fake-token",
    });
    expect(
      sourceInstallIntent({
        ...draft,
        presetId: preset.id,
        presets: [{ ...preset, endpoint: "input" }],
      }),
    ).toEqual({
      presetId: preset.id,
      name: "Mine",
      endpoint: "https://custom.example.test/mcp",
      credential: "fake-token",
    });
  });
  it("does not choose another preset when the selected id disappears", () => {
    expect(() => sourceInstallIntent({ ...draft, presetId: "removed" })).toThrow("not available");
    expect(
      sourceInstallIntent({
        ...draft,
        presetId: preset.id,
        presets: [{ ...preset, credential: "none" }],
      }),
    ).not.toHaveProperty("credential");
  });
  it.each(["mcp", "api", "graphql"] as const)("retains a generic %s source", (kind) => {
    const intent = sourceInstallIntent({ ...draft, kind });
    expect(intent).toMatchObject({
      kind,
      name: "Mine",
      source: "https://custom.example.test/mcp",
      credential: "fake-token",
      config: { auth: { type: "header", name: "x-key" } },
    });
    expect(intent).not.toHaveProperty("presetId");
  });
});
