// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { DecisionProviderError, ModelAccountError, SecretNotFoundError } from "@orkbot/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AutoReviewConnectionUnavailableError,
  AutoReviewProviderConstructionError,
  autoReviewFailure,
  logAutoReviewFailure,
  normalizeAutoReviewFailure,
} from "./auto-review-failures.js";
import { HostedModelCreditsRequiredError } from "./model-credit-observer.js";
import { UnavailableModelForAuthError } from "./model-selection.js";
import { RetiredModelCredentialError } from "./pi-oauth.js";

afterEach(() => vi.restoreAllMocks());
describe("checker failure classification", () => {
  it.each([
    [new HostedModelCreditsRequiredError("private"), "credits_required"],
    [new ModelAccountError("insufficient_quota private"), "credits_required"],
    [new ModelAccountError("invalid_api_key private"), "decision_auth"],
    [new ModelAccountError("Unknown model private"), "model_unavailable"],
    [new DecisionProviderError("invalid_response"), "unexpected"],
    [new AutoReviewConnectionUnavailableError("private"), "connection_unavailable"],
    [new RetiredModelCredentialError("private"), "connection_unavailable"],
    [new SecretNotFoundError(), "connection_unavailable"],
    [new UnavailableModelForAuthError("private"), "model_unavailable"],
    [new DecisionProviderError("authentication"), "decision_auth"],
    [new AutoReviewProviderConstructionError("private"), "provider_construction"],
    [new ModelAccountError("insufficient credits private"), "credits_required"],
    [new ModelAccountError("invalid_api_key private"), "decision_auth"],
    [new ModelAccountError("unknown model private"), "model_unavailable"],
    [new DecisionProviderError("unavailable"), "unexpected"],
    [new ModelAccountError("context length private"), "unexpected"],
    [new Error("Encrypted secret is malformed"), "decrypt"],
    [new Error("Unsupported state or unable to authenticate data"), "decrypt"],
    [Object.assign(new Error("private"), { code: "ERR_OSSL_BAD_DECRYPT" }), "decrypt"],
    [new Error("Stored model credential is corrupt. Connect the provider again."), "decrypt"],
    [
      new Error("Not enough model credits. Add credits in Billing or connect your own API key."),
      "credits_required",
    ],
    [new Error("Connect that model provider again."), "connection_unavailable"],
    [new Error("Backup model credential is no longer available"), "connection_unavailable"],
    [
      new Error(
        "The workspace model connection is unavailable. Ask the workspace owner to check it.",
      ),
      "connection_unavailable",
    ],
    [new ModelAccountError("insufficient_quota private"), "credits_required"],
    [new ModelAccountError("invalid_api_key private"), "decision_auth"],
    [new ModelAccountError("model not found private"), "model_unavailable"],
    [new DecisionProviderError("unavailable"), "unexpected"],
    [new Error("private"), "unexpected"],
    ["private", "unexpected"],
    [null, "unexpected"],
  ])("classifies %s without exposing its text", (error, code) => {
    const result = autoReviewFailure(error, "provider/model");
    expect(result).toMatchObject({ decision: "error", model: "provider/model", failureCode: code });
    expect(result.reason).not.toContain("private");
  });
  it.each(["Checker timed out.", "Checker returned no decision."])(
    "preserves useful recognized result: %s",
    (reason) => {
      expect(normalizeAutoReviewFailure({ decision: "error", model: "model", reason }).reason).toBe(
        reason,
      );
    },
  );
  it("rejects arbitrary provider-returned reasons and preserves typed result codes", () => {
    expect(
      normalizeAutoReviewFailure({
        decision: "error",
        model: "model",
        reason: "secret action args",
      }).reason,
    ).toBe("Checker could not complete the review.");
    expect(
      normalizeAutoReviewFailure(autoReviewFailure(new UnavailableModelForAuthError(), "model")),
    ).toMatchObject({ failureCode: "model_unavailable" });
    expect(
      normalizeAutoReviewFailure({
        decision: "error",
        model: "model",
        reason: "Checker could not authenticate.",
      }),
    ).toMatchObject({ failureCode: "decision_auth" });
  });
  it("logs only categorical metadata, excluding connection/model and invalid provider text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logAutoReviewFailure(
      {
        provider: "https://secret.invalid/key",
        model: "secret-model",
        credentialId: "secret-id",
        role: "default",
        fallback: true,
      },
      "decrypt",
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith("[auto-review] checker failed", {
      code: "decrypt",
      provider: "custom",
      role: "default",
      fallback: true,
    });
  });
});
