// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { RpcOutput } from "@orkbot/contracts";
import { describe, expect, it } from "vitest";
import { formatAIBudget, parseAIBudget, workspaceAIUpdate } from "./server-ai-settings.js";

describe("AI budget input", () => {
  it.each([
    ["", null],
    ["  ", null],
    ["0", 0],
    ["1.25", 1250000],
    ["1,25", 1250000],
    ["0.000001", 1],
    ["9007199254.740991", Number.MAX_SAFE_INTEGER],
  ])("parses %s exactly", (input, expected) => {
    expect(parseAIBudget(input)).toBe(expected);
    expect(parseAIBudget(formatAIBudget(expected))).toBe(expected);
  });
  it.each(["-1", "1e3", "NaN", "Infinity", "1.0000001", "1.2.3", "9007199254.740992", "0x10"])(
    "rejects %s",
    (input) => expect(() => parseAIBudget(input)).toThrow("Invalid budget"),
  );
  it.each([-1, 0.1, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "refuses an invalid stored budget %s",
    (input) => expect(() => formatAIBudget(input)).toThrow(),
  );
});

it("preserves the assignment budget and exact connection while changing one setting", () => {
  const row: RpcOutput<"serverAI/status">["connections"][number] = {
    id: "account-a",
    label: "Account A",
    provider: "openai",
    models: ["a", "b"],
    state: "active",
    revision: 3,
    concurrencyLimit: 8,
    enabled: true,
    allowedModels: ["a"],
    defaultModelId: "a",
    isDefault: true,
    fallback: false,
    priority: 4,
    assignmentRevision: 2,
    monthlyBudgetMicros: 1234567,
  };
  expect(workspaceAIUpdate(row, { fallback: true })).toEqual({
    connectionId: "account-a",
    enabled: true,
    allowedModels: ["a"],
    defaultModelId: "a",
    isDefault: true,
    fallback: true,
    priority: 4,
    monthlyBudgetMicros: 1234567,
  });
  const untrustedPatch = { fallback: true, connectionId: "account-b" };
  expect(workspaceAIUpdate(row, untrustedPatch).connectionId).toBe("account-a");
});
