// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it } from "vitest";
import {
  ModelCatalogEntrySchema,
  ModelConnectInputSchema,
  ModelConnectionMetadataSchema,
  ModelRoutingValuesSchema,
} from "./domain.js";
import { normalizeModelRouting } from "./model-routing.js";
import { compatibleEndpointPreset, modelEndpointIdentity } from "./openai-compatible-ui.js";

const fields = [
  { key: "tenant", label: "Tenant", required: true },
  { key: "route", label: "Route", required: false },
];

describe("generic model connection metadata", () => {
  it("accepts another adapter's fields and presets without shared provider knowledge", () => {
    const connection = {
      routingFields: fields,
      presets: [
        {
          label: "Example",
          baseUrl: "https://models.example.test/v2",
          apiProtocol: "responses",
          apiKeyRequired: true,
        },
      ],
    };
    expect(
      ModelCatalogEntrySchema.parse({
        provider: "synthetic",
        id: "synthetic-model",
        label: "Synthetic",
        billing: "Own key",
        connection,
      }).connection,
    ).toEqual(connection);
    expect(normalizeModelRouting(fields, { tenant: "  tenant_1 ", route: " " })).toEqual({
      tenant: "tenant_1",
    });
  });

  it("requires complete declared routes and rejects undeclared fields", () => {
    expect(normalizeModelRouting(fields, {})).toBeUndefined();
    expect(normalizeModelRouting(fields, { route: "value" })).toBeUndefined();
    expect(normalizeModelRouting(fields, { tenant: "tenant-1", extra: "value" })).toBeUndefined();
    expect(normalizeModelRouting([fields[0]!, fields[0]!], { tenant: "tenant-1" })).toBeUndefined();
    expect(
      normalizeModelRouting([{ key: "constructor", label: "Route", required: true }], {}),
    ).toBeUndefined();
  });

  it("carries routing-only updates without claiming that a new connection has an existing key", () => {
    expect(
      ModelConnectInputSchema.parse({ provider: "synthetic", routing: { tenant: "tenant-1" } }),
    ).toMatchObject({ routing: { tenant: "tenant-1" } });
    expect(ModelConnectInputSchema.safeParse({ provider: "synthetic" }).success).toBe(false);
  });

  it.each(["..", "a/b", "a\\b", "a%2Fb", "a?b", "a#b", "https://example.test", "a".repeat(65)])(
    "rejects an unsafe path segment %s",
    (tenant) => {
      expect(normalizeModelRouting(fields, { tenant })).toBeUndefined();
      expect(ModelRoutingValuesSchema.safeParse({ tenant }).success).toBe(false);
    },
  );

  it("bounds keys, fields and preset data and rejects credentials inside URLs", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      key: `field${index}`,
      label: "Field",
      required: true,
    }));
    expect(ModelConnectionMetadataSchema.safeParse({ routingFields: many }).success).toBe(false);
    expect(
      ModelConnectionMetadataSchema.safeParse({ routingFields: [fields[0], fields[0]] }).success,
    ).toBe(false);
    expect(
      ModelConnectionMetadataSchema.safeParse({
        presets: Array.from({ length: 17 }, () => ({
          label: "Example",
          baseUrl: "https://models.example.test",
        })),
      }).success,
    ).toBe(false);
    expect(
      ModelConnectionMetadataSchema.safeParse({
        presets: [{ label: "Example", baseUrl: "https://user:password@models.example.test" }],
      }).success,
    ).toBe(false);
    expect(
      ModelRoutingValuesSchema.safeParse(Object.fromEntries(many.map(({ key }) => [key, "value"])))
        .success,
    ).toBe(false);
    expect(
      ModelRoutingValuesSchema.safeParse(Object.fromEntries([["__proto__", "value"]])).success,
    ).toBe(false);
  });
});

describe("compatible endpoint identity", () => {
  it("normalizes host, default port and trailing slash without merging paths or queries", () => {
    expect(modelEndpointIdentity(" HTTPS://MODELS.EXAMPLE.TEST:443/v1/ ")).toBe(
      "https://models.example.test/v1",
    );
    expect(modelEndpointIdentity("https://models.example.test/v1/route")).not.toBe(
      modelEndpointIdentity("https://models.example.test/v1/other"),
    );
    expect(modelEndpointIdentity("https://models.example.test/v1/Route")).not.toBe(
      modelEndpointIdentity("https://models.example.test/v1/route"),
    );
    expect(modelEndpointIdentity("https://models.example.test/v1?route=a")).not.toBe(
      modelEndpointIdentity("https://models.example.test/v1?route=b"),
    );
    expect(modelEndpointIdentity("https://models.example.test/v1?a=1&b=2")).not.toBe(
      modelEndpointIdentity("https://models.example.test/v1?b=2&a=1"),
    );
  });

  it("matches typed canonical endpoints to neutral preset policy and ignores incomplete input", () => {
    const preset = {
      label: "Example",
      baseUrl: "https://models.example.test/v1",
      apiKeyRequired: true,
    };
    expect(compatibleEndpointPreset("https://MODELS.EXAMPLE.TEST:443/", [preset])).toBe(preset);
    expect(
      compatibleEndpointPreset("https://models.example.test/v1?route=other", [preset]),
    ).toBeUndefined();
    expect(compatibleEndpointPreset("https://models.example.test/other", [preset])).toBeUndefined();
    expect(compatibleEndpointPreset("not a URL", [preset])).toBeUndefined();
  });
});
