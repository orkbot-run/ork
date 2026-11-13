// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/** Google adapters preserve the SDK's JSON error but expose no response or fetch hook. */
export function googleQuotaResponse(
  errorMessage: string | undefined,
): { status: 429; retryAfter: string | null } | undefined {
  if (!errorMessage || errorMessage.length > 32 * 1024) return undefined;
  try {
    const parsed: unknown = JSON.parse(errorMessage);
    if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return undefined;
    const error = parsed.error;
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== 429)
      return undefined;
    let seconds = 0;
    if ("details" in error && Array.isArray(error.details)) {
      for (const detail of error.details.slice(0, 100)) {
        if (
          !detail ||
          typeof detail !== "object" ||
          detail["@type"] !== "type.googleapis.com/google.rpc.RetryInfo" ||
          typeof detail.retryDelay !== "string" ||
          !/^\d{1,12}(?:\.\d{1,9})?s$/.test(detail.retryDelay)
        )
          continue;
        seconds = Math.max(seconds, Math.ceil(Number(detail.retryDelay.slice(0, -1))));
      }
    }
    return { status: 429, retryAfter: seconds > 0 ? String(seconds) : null };
  } catch {
    return undefined;
  }
}
