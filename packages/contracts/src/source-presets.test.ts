// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it } from "vitest";
import { appContract } from "./rpc.js";
import { SourcePresetInstallSchema, SourcePresetSchema } from "./source-presets.js";

describe("source preset intent", () => {
  it("accepts only neutral bounded metadata", () => {
    expect(
      SourcePresetSchema.parse({
        id: "fixture:v2",
        label: "Fixture",
        kind: "api",
        endpoint: "fixed",
        credential: "optional",
        source: "https://private.example.test",
        auth: "fake-secret",
      }),
    ).toEqual({
      id: "fixture:v2",
      label: "Fixture",
      kind: "api",
      endpoint: "fixed",
      credential: "optional",
    });
    expect(SourcePresetSchema.safeParse({ id: "bad/id" }).success).toBe(false);
  });
  it.each(["kind", "source", "config", "auth", "pluginDigest", "pluginParts"])(
    "rejects client %s overrides even through the legacy union branch",
    (field) => {
      const input = {
        presetId: "fixture",
        name: "Fixture",
        [field]: field === "config" ? {} : "override",
      };
      expect(SourcePresetInstallSchema.safeParse(input).success).toBe(false);
      expect(appContract.capabilities.install["~orpc"].inputSchema!.safeParse(input).success).toBe(
        false,
      );
    },
  );
  it("retains custom protocol inputs without a preset id", () => {
    expect(
      appContract.capabilities.install["~orpc"].inputSchema!.safeParse({
        kind: "mcp",
        name: "Custom",
        source: "https://example.test/mcp",
        config: { auth: { type: "none" } },
      }).success,
    ).toBe(true);
  });
});
