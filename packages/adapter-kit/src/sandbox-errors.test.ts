// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { COMPUTER_ACCOUNT_REFUSED_ERROR } from "@orkbot/contracts";
import { expect, it } from "vitest";
import { SandboxAccountError } from "./sandbox-errors.js";

it("keeps account refusal public copy neutral while retaining its private cause", () => {
  const cause = new Error("upstream private-provider-key refused");
  const error = new SandboxAccountError({ cause });
  expect(error.message).toBe(COMPUTER_ACCOUNT_REFUSED_ERROR);
  expect(error.code).toBe("SANDBOX_ACCOUNT_REFUSED");
  expect(error.cause).toBe(cause);
  expect(JSON.stringify(error)).not.toContain("private-provider-key");
});
