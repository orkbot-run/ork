// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sanitizeModelConnectionError } from "./model-connection-error.js";

describe("model connection errors", () => {
  it.each(["fixture-🔐-ключ-ü", "fixture-lone-\ud800-surrogate", "  fixture-padding-key  "])(
    "masks credentials with Unicode or padding",
    (credential) => {
      expect(sanitizeModelConnectionError(`rejected ${credential}`, [credential])).not.toContain(
        credential,
      );
      expect(
        sanitizeModelConnectionError(`rejected ${credential.trim()}`, [credential]),
      ).not.toContain(credential.trim());
    },
  );
  it("masks submitted or stored secrets before generic credential patterns", () => {
    const credentials = ['fixture key / + "quoted"', "fixture-routing-header"];
    const variants = credentials.flatMap((secret) => [
      secret,
      encodeURIComponent(secret),
      Array.from(
        new TextEncoder().encode(secret),
        (byte) => `%${byte.toString(16).padStart(2, "0")}`,
      ).join(""),
      encodeURIComponent(secret).replaceAll("%20", "+"),
      JSON.stringify(secret).slice(1, -1),
    ]);
    const raw = `401: ${variants.join(" | ")} token=unknown-value`;
    const output = sanitizeModelConnectionError(raw, credentials);
    for (const variant of variants) expect(output).not.toContain(variant);
    expect(output).not.toContain("unknown-value");
    expect(output).toContain("401");
    expect(sanitizeModelConnectionError(output, credentials)).toBe(output);
  });

  it("supports nonstandard credentials, Unicode and URL escaping", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 8, maxLength: 50 }), (credential) => {
        const variants = [
          credential,
          encodeURIComponent(credential),
          JSON.stringify(credential).slice(1, -1),
        ];
        const output = sanitizeModelConnectionError(`Failure: ${variants.join(" | ")}`, [
          credential,
        ]);
        for (const variant of variants) expect(output).not.toContain(variant);
      }),
      { seed: 301, numRuns: 200 },
    );
  });

  it("masks alternate escaping even next to incomplete escapes", () => {
    const credential = "fixture@sample/part";
    const raw = String.raw`failed %66ixture%40sample%2fpart%FF and fixture\u0040sample\/part`;
    expect(sanitizeModelConnectionError(raw, [credential])).toBe(
      "failed [redacted]%FF and [redacted]",
    );
  });

  it("keeps redaction markers stable even when a credential matches the marker text", () => {
    const credentials = ["redacted", "prefix[redacted]suffix"];
    const first = sanitizeModelConnectionError(
      "failed prefix[redacted]suffix redacted",
      credentials,
    );
    expect(first).toBe("failed [redacted] [redacted]");
    expect(sanitizeModelConnectionError(first, credentials)).toBe(first);
  });
});
