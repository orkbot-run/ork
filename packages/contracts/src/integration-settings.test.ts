// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it } from "vitest";
import {
  ConfiguredIntegrationSchema,
  IntegrationProviderConfigSchema,
  IntegrationProviderIdSchema,
} from "./integration-settings.js";

describe("neutral integration contracts", () => {
  it("preserves opaque registered ids without a vendor inventory or case conversion", () => {
    for (const id of ["Adapter.third-v2", "tenant:connector", "custom_adapter"]) {
      expect(IntegrationProviderIdSchema.parse(id)).toBe(id);
      expect(
        ConfiguredIntegrationSchema.parse({ id, privateCredential: "fixture-private-value" }),
      ).toEqual({ id });
    }
  });
  it.each(["", "has spaces", "../adapter", "adapter/path", "a".repeat(129)])(
    "rejects an invalid id: %j",
    (id) => {
      expect(IntegrationProviderIdSchema.safeParse(id).success).toBe(false);
    },
  );
  it("accepts bounded opaque string fields without validating provider secrets in shared code", () => {
    expect(
      IntegrationProviderConfigSchema.parse({
        provider: "fixture",
        credential: "",
        tenant: "first",
      }),
    ).toEqual({ provider: "fixture", credential: "", tenant: "first" });
  });
  it("bounds field count, key length, per-field length and aggregate UTF-8 bytes", () => {
    expect(
      IntegrationProviderConfigSchema.safeParse({
        provider: "fixture",
        ...Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`field${index}`, "value"])),
      }).success,
    ).toBe(false);
    expect(
      IntegrationProviderConfigSchema.safeParse({ provider: "fixture", ["k".repeat(65)]: "value" })
        .success,
    ).toBe(false);
    expect(
      IntegrationProviderConfigSchema.safeParse({
        provider: "fixture",
        credential: "x".repeat(16_385),
      }).success,
    ).toBe(false);
    expect(
      IntegrationProviderConfigSchema.safeParse({
        provider: "fixture",
        first: "ą".repeat(16_384),
        second: "ą".repeat(16_384),
      }).success,
    ).toBe(false);
    expect(
      IntegrationProviderConfigSchema.safeParse({
        provider: "fixture",
        credential: { secret: "value" },
      }).success,
    ).toBe(false);
  });
});
