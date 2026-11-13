// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it } from "vitest";
import { googleQuotaResponse } from "./google-quota-response.js";

const message = (details: unknown[] = [], code = 429) =>
  JSON.stringify({ error: { code, details } });
describe("SDK quota metadata", () => {
  it.each([
    undefined,
    "429 rate limit",
    "{",
    "null",
    "[]",
    "x".repeat(32 * 1024 + 1),
    JSON.stringify({ error: { code: "429" } }),
    message([], 500),
  ])("ignores unstructured or unrelated failure %s", (failure) => {
    expect(googleQuotaResponse(failure)).toBeUndefined();
  });
  it("uses the account's default cooldown when no valid retry duration is present", () => {
    expect(
      googleQuotaResponse(
        message([
          { "@type": "unknown", retryDelay: "90s" },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "-1s" },
        ]),
      ),
    ).toEqual({ status: 429, retryAfter: null });
  });
  it("retains the longest valid delay and rounds fractional seconds upwards", () => {
    expect(
      googleQuotaResponse(
        message([
          1,
          null,
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "120.001s" },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "10s" },
        ]),
      ),
    ).toEqual({ status: 429, retryAfter: "121" });
  });
});
