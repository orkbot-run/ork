// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited candidate traversal is preserved; Ork failure classification follows LICENSE.md.

import type { AutoReviewResult } from "@orkbot/adapter-kit";
import type { AutoReviewChecker } from "./auto-review.js";
import type { AutoReviewFailureResult } from "./auto-review-failures.js";
import {
  autoReviewFailure,
  logAutoReviewFailure,
  normalizeAutoReviewFailure,
} from "./auto-review-failures.js";

export type AutoReviewCandidate = AutoReviewChecker & {
  role: "member" | "backup" | "default";
  fallback?: boolean;
  instance?: true;
};

/** Deliberate decisions are final. Only unavailable checkers advance to an ordered backup. */
export async function reviewWithBackups(
  candidates: AutoReviewCandidate[],
  review: (candidate: AutoReviewCandidate) => Promise<AutoReviewResult>,
  signal: AbortSignal,
): Promise<
  (AutoReviewResult & { failureCode?: AutoReviewFailureResult["failureCode"] }) | undefined
> {
  let firstFailure: AutoReviewFailureResult | undefined;
  let memberFailure: AutoReviewFailureResult | undefined;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (signal.aborted) return undefined;
    const key = JSON.stringify([
      candidate.provider,
      candidate.model,
      candidate.credentialId ?? null,
      candidate.instance === true,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    let result: AutoReviewResult;
    try {
      result = await review(candidate);
    } catch (error) {
      if (signal.aborted) return undefined;
      result = autoReviewFailure(error, `${candidate.provider}/${candidate.model}`);
    }
    if (signal.aborted) return undefined;
    if (result.decision !== "error") return result;
    const failed = normalizeAutoReviewFailure({
      ...result,
      model: `${candidate.provider}/${candidate.model}`,
    });
    logAutoReviewFailure(candidate, failed.failureCode);
    firstFailure ??= failed;
    if (candidate.role === "member") memberFailure ??= failed;
  }
  return signal.aborted
    ? undefined
    : (memberFailure ?? firstFailure ?? autoReviewFailure(undefined, "unavailable"));
}
