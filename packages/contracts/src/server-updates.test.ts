// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it } from "vitest";
import {
  ServerUpdatesApplySchema,
  ServerUpdatesCheckSchema,
  ServerUpdatesPolicySchema,
} from "./server-updates.js";

describe("server update wire authority", () => {
  it.each(["repoUrl", "branch", "image", "url", "command"])(
    "rejects legacy or host-control field %s on every write",
    (key) => {
      expect(ServerUpdatesCheckSchema.safeParse({ [key]: "untrusted" }).success).toBe(false);
      expect(
        ServerUpdatesApplySchema.safeParse({
          candidateRevision: "a".repeat(40),
          idempotencyKey: "00000000-0000-4000-8000-000000000001",
          [key]: "untrusted",
        }).success,
      ).toBe(false);
      expect(
        ServerUpdatesPolicySchema.safeParse({
          automatic: true,
          expectedRevision: 0,
          [key]: "untrusted",
        }).success,
      ).toBe(false);
    },
  );
  it("requires a full candidate revision and a request key", () => {
    for (const candidateRevision of [
      "latest",
      "edge",
      "a".repeat(7),
      "A".repeat(40),
      "https://example.test/image",
    ]) {
      expect(
        ServerUpdatesApplySchema.safeParse({
          candidateRevision,
          idempotencyKey: "00000000-0000-4000-8000-000000000001",
        }).success,
      ).toBe(false);
    }
    expect(
      ServerUpdatesApplySchema.safeParse({
        candidateRevision: "a".repeat(40),
        idempotencyKey: "retry",
      }).success,
    ).toBe(false);
  });
});
