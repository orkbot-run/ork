// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it } from "vitest";
import { isRecordNotFound, isUniqueViolation } from "./database-errors.js";

describe("database error predicates", () => {
  it("accepts only the matching direct object code", () => {
    expect(isUniqueViolation(Object.assign(new Error("conflict"), { code: "P2002" }))).toBe(true);
    expect(isRecordNotFound({ code: "P2025" })).toBe(true);
    expect(isUniqueViolation(Object.create({ code: "P2002" }))).toBe(true);
    for (const value of [
      null,
      undefined,
      "P2002",
      1,
      {},
      { code: 2002 },
      { code: "p2002" },
      { cause: { code: "P2002" } },
      Object.assign(() => {}, { code: "P2002" }),
    ]) {
      expect(isUniqueViolation(value)).toBe(false);
      expect(isRecordNotFound(value)).toBe(false);
    }
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(isUniqueViolation(cycle)).toBe(false);
    expect(isRecordNotFound(cycle)).toBe(false);
    expect(isRecordNotFound({ code: "P2002" })).toBe(false);
    expect(isUniqueViolation({ code: "P2025" })).toBe(false);
  });
});
