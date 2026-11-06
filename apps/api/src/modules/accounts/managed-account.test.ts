// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it } from "vitest";
import { managedAccountKeyForRequest } from "./managed-account.js";

const owner = "ab".repeat(32);
const capability = "cd".repeat(32);
it("reveals the managed binding only to the private native capability", () => {
  expect(managedAccountKeyForRequest(owner, capability, capability)).toBe(owner);
  for (const supplied of [undefined, "", owner, "x".repeat(64), capability.toUpperCase()])
    expect(managedAccountKeyForRequest(owner, capability, supplied)).toBeUndefined();
});
it("does not invent an owner for an unmanaged or malformed configuration", () => {
  expect(managedAccountKeyForRequest(undefined, capability, capability)).toBeUndefined();
  expect(managedAccountKeyForRequest(owner, undefined, capability)).toBeUndefined();
  expect(managedAccountKeyForRequest("invalid", capability, capability)).toBeUndefined();
});
