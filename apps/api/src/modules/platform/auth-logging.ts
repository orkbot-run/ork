// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { LogBindings, Logger } from "@orkbot/logging";

const stages = new Map([
  ["Failed to validate authorization code", "token_exchange"],
  ["OAuth issuer mismatch", "issuer_validation"],
  [
    "OAuth id_token nonce binding required but no expected nonce was found in state",
    "callback_state",
  ],
  ["Unable to get user info", "user_info"],
  ["Unable to derive provider account identity", "account_identity"],
  ["Invalid password", "password_verification"],
]);
const errorCodes = new Set([
  "access_denied",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "invalid_scope",
  "unauthorized_client",
  "unsupported_grant_type",
  "server_error",
  "temporarily_unavailable",
  "SSO_UNAVAILABLE",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Keep protocol diagnostics without logging upstream bodies, URLs or credentials. */
function failureFields(message: string, args: unknown[]): LogBindings {
  const fields: LogBindings = { "auth.stage": stages.get(message) ?? "authentication" };
  for (const arg of args) {
    const outer = record(arg);
    if (!outer) continue;
    // Token errors may be plain response objects; network errors often have a cause.
    for (const item of [outer, outer.body, outer.data, outer.error, outer.cause, outer.response]) {
      const detail = record(item);
      if (!detail) continue;
      const status = detail.status ?? detail.statusCode;
      if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599)
        fields["http.response.status_code"] ??= status;
      for (const code of [detail.error, detail.code]) {
        if (typeof code === "string" && errorCodes.has(code)) fields["auth.error_code"] ??= code;
      }
    }
  }
  return fields;
}

export function authenticationLogger(logger: () => Pick<Logger, "error">) {
  return {
    level: "error" as const,
    log: (_level: unknown, message: string, ...args: unknown[]) =>
      logger().error("auth.request.failed", failureFields(message, args)),
  };
}
