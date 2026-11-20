// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AutoReviewResult } from "@orkbot/adapter-kit";
import {
  DecisionProviderError,
  isModelCredentialRejected,
  ModelAccountError,
  SecretNotFoundError,
  SecretStoreUnavailableError,
} from "@orkbot/adapter-kit";
import { ContentDecryptionError } from "@orkbot/db";
import type { AutoReviewCandidate } from "./auto-review-backups.js";
import { HostedModelCreditsRequiredError } from "./model-credit-observer.js";
import { UnavailableModelForAuthError } from "./model-selection.js";
import { isOpenRouterZdrPolicyFailure } from "./openrouter-zdr.js";
import { RetiredModelCredentialError } from "./pi-oauth.js";
import { AIConnectionError } from "./server-ai-catalog.js";

export type AutoReviewFailureCode =
  | "credits_required"
  | "connection_unavailable"
  | "model_unavailable"
  | "decision_auth"
  | "provider_construction"
  | "decrypt"
  | "unexpected";
export type AutoReviewFailureResult = AutoReviewResult & {
  decision: "error";
  failureCode: AutoReviewFailureCode;
  policyBlocked?: true;
};

export class AutoReviewConnectionUnavailableError extends Error {}
export class AutoReviewProviderConstructionError extends Error {}

const reasons: Record<AutoReviewFailureCode, string> = {
  credits_required: "Checker has no model credits. Add credits or choose another connection.",
  connection_unavailable:
    "Checker connection is unavailable. Reconnect it or choose another connection.",
  model_unavailable: "Checker model is unavailable. Choose another model.",
  decision_auth: "Checker could not authenticate. Reconnect it or update its credentials.",
  provider_construction:
    "Checker provider could not be configured. Check the instance configuration.",
  decrypt: "Checker credentials could not be decrypted. Save the connection again.",
  unexpected: "Checker could not complete the review.",
};

function failure(code: AutoReviewFailureCode, model: string): AutoReviewFailureResult {
  return { decision: "error", model, reason: reasons[code], failureCode: code };
}

/** Match known failure signatures, but never copy an exception's text into the result. */
export function autoReviewFailure(error: unknown, model: string): AutoReviewFailureResult {
  if (isOpenRouterZdrPolicyFailure(error))
    return { ...failure("model_unavailable", model), policyBlocked: true };
  if (
    error instanceof HostedModelCreditsRequiredError ||
    (error instanceof DecisionProviderError && error.kind === "credits_required") ||
    (error instanceof AIConnectionError && error.code === "budget")
  )
    return failure("credits_required", model);
  if (
    error instanceof AutoReviewConnectionUnavailableError ||
    error instanceof RetiredModelCredentialError ||
    error instanceof SecretNotFoundError ||
    error instanceof SecretStoreUnavailableError ||
    (error instanceof AIConnectionError && error.code !== "busy")
  )
    return failure("connection_unavailable", model);
  if (
    error instanceof UnavailableModelForAuthError ||
    (error instanceof DecisionProviderError && error.kind === "model_unavailable")
  )
    return failure("model_unavailable", model);
  if (error instanceof DecisionProviderError && error.kind === "authentication")
    return failure("decision_auth", model);
  if (error instanceof AutoReviewProviderConstructionError)
    return failure("provider_construction", model);
  if (error instanceof ContentDecryptionError) return failure("decrypt", model);
  if (error instanceof Error) {
    if (
      [
        "Connect that model provider again.",
        "Connect that model provider first",
        "Backup model credential is no longer available",
        "Selected checker connection is unavailable",
        "The workspace model connection is unavailable. Ask the workspace owner to check it.",
      ].includes(error.message)
    )
      return failure("connection_unavailable", model);
    // Local encryption reports malformed envelopes or Node/OpenSSL authentication failures.
    if (
      error.message === "Encrypted secret is malformed" ||
      error.message === "Stored model credential is corrupt. Connect the provider again." ||
      error.message === "Unsupported state or unable to authenticate data" ||
      ("code" in error && error.code === "ERR_OSSL_BAD_DECRYPT")
    )
      return failure("decrypt", model);
    // reserveModelCredits currently throws this fixed public message rather than a typed error.
    if (
      error.message ===
      "Not enough model credits. Add credits in Billing or connect your own API key."
    )
      return failure("credits_required", model);
    if (error instanceof ModelAccountError) {
      if (isModelCredentialRejected(error)) return failure("decision_auth", model);
      if (
        /insufficient[ _](?:credits?|balance|quota)|out of credits|usage limit|quota exceeded/i.test(
          error.message,
        )
      )
        return failure("credits_required", model);
      if (
        /model not found|unknown model|model.*(?:unavailable|retired|decommissioned)/i.test(
          error.message,
        )
      )
        return failure("model_unavailable", model);
    }
  }
  return failure("unexpected", model);
}

const safeReturnedReasons = new Set([
  "Checker timed out.",
  "Checker timed out or failed.",
  "Checker returned no decision.",
  "Checker request was invalid.",
  "Checker is busy.",
  "Checker could not authenticate.",
  "Checker failed.",
]);

/** Returned error text is untrusted too: retain only fixed, provider-neutral diagnostics. */
export function normalizeAutoReviewFailure(result: AutoReviewResult): AutoReviewFailureResult {
  const code = (result as Partial<AutoReviewFailureResult>).failureCode;
  if (code && Object.hasOwn(reasons, code))
    return {
      ...failure(code, result.model),
      ...((result as Partial<AutoReviewFailureResult>).policyBlocked
        ? { policyBlocked: true }
        : {}),
    };
  if (result.reason === "Checker could not authenticate.")
    return failure("decision_auth", result.model);
  return {
    ...failure("unexpected", result.model),
    ...(result.reason && safeReturnedReasons.has(result.reason) ? { reason: result.reason } : {}),
  };
}

/** No model/connection IDs, action data, or exception text may enter this diagnostic. */
export function logAutoReviewFailure(
  candidate: AutoReviewCandidate,
  code: AutoReviewFailureCode,
): void {
  // Provider IDs are catalog identifiers; exclude URLs and malformed/user-supplied text.
  const provider = /^[a-z][a-z0-9-]{0,47}$/.test(candidate.provider)
    ? candidate.provider
    : "custom";
  // biome-ignore lint/suspicious/noConsole: Emit a bounded diagnostic without request or credential data.
  console.warn("[auto-review] checker failed", {
    code,
    provider,
    role: candidate.role,
    fallback: candidate.fallback === true,
  });
}
