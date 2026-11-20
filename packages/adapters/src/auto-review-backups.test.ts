// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; Ork review failure handling follows LICENSE.md.

import type { AutoReviewResult } from "@orkbot/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutoReviewCandidate } from "./auto-review-backups.js";
import { reviewWithBackups } from "./auto-review-backups.js";
import { AutoReviewConnectionUnavailableError } from "./auto-review-failures.js";
import { HostedModelCreditsRequiredError } from "./model-credit-observer.js";

const candidates: AutoReviewCandidate[] = [
  { provider: "openai", model: "first", role: "member" },
  { provider: "anthropic", model: "second", role: "backup" },
  { provider: "openrouter", model: "third", role: "default", fallback: true },
];
afterEach(() => vi.restoreAllMocks());
describe("approval model backups", () => {
  it.each(["pass", "ask"] as const)("never retries a deliberate %s", async (decision) => {
    const review = vi.fn(async () => ({ decision, model: "first" }));
    expect(
      (await reviewWithBackups(candidates, review, new AbortController().signal))?.decision,
    ).toBe(decision);
    expect(review).toHaveBeenCalledTimes(1);
  });
  it("tries backups and default in order, deduplicating provider/model/connection", async () => {
    const personal = { ...candidates[0]!, credentialId: "personal" };
    const work = { ...personal, credentialId: "work", role: "backup" as const };
    const review = vi
      .fn<() => Promise<AutoReviewResult>>()
      .mockRejectedValueOnce(new Error("fake secret"))
      .mockRejectedValueOnce(new Error("fake secret"))
      .mockResolvedValueOnce({ decision: "error", model: "second" })
      .mockResolvedValueOnce({ decision: "pass", model: "third" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await reviewWithBackups(
      [personal, personal, work, candidates[1]!, candidates[2]!],
      review,
      new AbortController().signal,
    );
    expect(result?.decision).toBe("pass");
    expect(review.mock.calls).toHaveLength(4);
    expect(review).toHaveBeenNthCalledWith(1, personal);
    expect(review).toHaveBeenNthCalledWith(2, work);
    expect(review).toHaveBeenNthCalledWith(3, candidates[1]);
    expect(review).toHaveBeenNthCalledWith(4, candidates[2]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/fake secret|personal|work|first|second/);
  });
  it("returns the member's actionable failure when every candidate fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const review = vi
      .fn<() => Promise<AutoReviewResult>>()
      .mockRejectedValueOnce(new HostedModelCreditsRequiredError("secret"))
      .mockRejectedValueOnce(new AutoReviewConnectionUnavailableError("private connection"))
      .mockRejectedValueOnce(new Error("private payload"));
    const result = await reviewWithBackups(candidates, review, new AbortController().signal);
    expect(result).toMatchObject({ model: "openai/first", failureCode: "credits_required" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(warn.mock.calls[2]?.[1]).toEqual({
      code: "unexpected",
      provider: "openrouter",
      role: "default",
      fallback: true,
    });
  });
  it("uses the first failure when there is no member selection", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const review = vi.fn(async () => ({
      decision: "error" as const,
      model: "original",
      reason: "Checker timed out.",
    }));
    expect(
      await reviewWithBackups([candidates[2]!], review, new AbortController().signal),
    ).toMatchObject({ reason: "Checker timed out." });
  });
  it("returns no result or failure log when canceled before review", async () => {
    const review = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await reviewWithBackups(candidates, review, AbortSignal.abort())).toBeUndefined();
    expect(review).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "does not record a result or failure when canceled during review (throws=%s)",
    async (throws) => {
      const controller = new AbortController();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const review = vi.fn(async () => {
        controller.abort();
        if (throws) throw new Error("secret");
        return { decision: "pass" as const, model: "first" };
      });
      expect(await reviewWithBackups(candidates, review, controller.signal)).toBeUndefined();
      expect(review).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    },
  );
});
