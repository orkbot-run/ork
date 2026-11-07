// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it } from "vitest";
import type { SourcePresetDefinition } from "./source-presets.js";
import {
  resolveLegacySourceConfig,
  resolveSourcePresetInstall,
  sourcePresets,
} from "./source-presets.js";

const fixture: SourcePresetDefinition = {
  id: "fixture:v2",
  label: "Fixture",
  kind: "api",
  endpoint: "fixed",
  credential: "required",
  source: "https://fixture.example.test/openapi.json",
  config: { auth: { type: "header", name: "x-fixture-key" } },
};
describe("source preset resolution", () => {
  it("exposes metadata without endpoint or auth configuration", () => {
    expect(sourcePresets([fixture])).toEqual([
      {
        id: fixture.id,
        label: fixture.label,
        kind: "api",
        endpoint: "fixed",
        credential: "required",
      },
    ]);
  });
  it("resolves an unrelated adapter preset with server-owned endpoint and auth", () => {
    const resolved = resolveSourcePresetInstall(
      { presetId: fixture.id, name: "Mine", credential: " fake-key " },
      [fixture],
    );
    expect(resolved).toEqual({
      kind: "api",
      name: "Mine",
      source: fixture.source,
      config: fixture.config,
      credential: "fake-key",
    });
    (resolved.config.auth as Record<string, unknown>).type = "none";
    expect(fixture.config.auth).toEqual({ type: "header", name: "x-fixture-key" });
    expect(() =>
      resolveSourcePresetInstall(
        { presetId: fixture.id, name: "Mine", endpoint: fixture.source, credential: "fake-key" },
        [fixture],
      ),
    ).toThrow("does not accept an endpoint");
  });
  it("rejects unknown ids without choosing the first available preset", () => {
    expect(() =>
      resolveSourcePresetInstall({ presetId: "removed", name: "Mine" }, [fixture]),
    ).toThrow("not available");
    expect(() => sourcePresets([fixture, fixture])).toThrow("Duplicate");
  });
  it("requires declared endpoint and credential inputs and forbids undeclared credentials", () => {
    const input = { ...fixture, endpoint: "input" as const, source: undefined };
    expect(() =>
      resolveSourcePresetInstall({ presetId: fixture.id, name: "Mine", credential: "fake-key" }, [
        input,
      ]),
    ).toThrow("endpoint is required");
    expect(() =>
      resolveSourcePresetInstall(
        { presetId: fixture.id, name: "Mine", endpoint: "https://example.test" },
        [input],
      ),
    ).toThrow("requires a credential");
    expect(
      resolveSourcePresetInstall(
        {
          presetId: fixture.id,
          name: "Mine",
          endpoint: "https://example.test",
          credential: "fake-key",
        },
        [input],
      ).source,
    ).toBe("https://example.test");
    expect(() =>
      resolveSourcePresetInstall({ presetId: fixture.id, name: "Mine", credential: "fake-key" }, [
        { ...fixture, credential: "none" },
      ]),
    ).toThrow("does not accept a credential");
  });
  it("keeps old wire selectors adapter-owned with fixed URL and authentication", () => {
    expect(
      resolveLegacySourceConfig("mcp", "https://untrusted.example.test", {
        preset: "treg",
        auth: { type: "none" },
        headers: { "x-public": "value" },
      }),
    ).toEqual({
      source: "https://treg.to/mcp/",
      config: { preset: "treg", auth: { type: "bearer" }, headers: { "x-public": "value" } },
    });
    expect(
      resolveLegacySourceConfig("mcp", "https://example.test/mcp", { preset: "custom" }).source,
    ).toBe("https://example.test/mcp");
  });
});
