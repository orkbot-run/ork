// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it } from "vitest";
import { MessagingSendError } from "./messaging-errors.js";

it.each([false, true])("does not infer rejection from permanent=%s", (permanent) => {
  const cause = new Error("unclassified send failure");
  const failure = new MessagingSendError(cause, { permanent, retryAfterMs: 1000 });
  expect(failure.outcome).toBe("unknown");
  expect(failure.cause).toBe(cause);
});

it("preserves an explicit rejection and its provider backoff", () => {
  const failure = new MessagingSendError(new Error("rejected"), {
    permanent: false,
    retryAfterMs: 30_000,
    outcome: "rejected",
  });
  expect(failure.outcome).toBe("rejected");
  expect(failure.retryAfterMs).toBe(30_000);
});
