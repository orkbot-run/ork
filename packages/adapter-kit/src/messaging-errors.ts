// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited send-error fields are preserved; explicit delivery outcomes are Ork additions.

/** Only a confirmed rejection permits retry after entering a send operation. */
export class MessagingSendError extends Error {
  override readonly name = "MessagingSendError";
  readonly permanent: boolean;
  readonly retryAfterMs: number | null;
  readonly outcome: "rejected" | "unknown";

  constructor(
    cause: unknown,
    options: {
      permanent: boolean;
      retryAfterMs: number | null;
      outcome?: "rejected" | "unknown";
    },
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.permanent = options.permanent;
    this.retryAfterMs = options.retryAfterMs;
    this.outcome = options.outcome ?? "unknown";
  }
}
