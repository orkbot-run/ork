// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it } from "vitest";
import type { McpFormField } from "./mcp-form.js";
import { McpFormAnswerSchema, validateMcpFormResponse, validateMcpFormValue } from "./mcp-form.js";

describe("MCP form contracts", () => {
  it("keeps false, zero and omitted optional values distinct without coercion", () => {
    const fields: McpFormField[] = [
      { name: "count", type: "integer", required: true, minimum: 0, maximum: 5 },
      { name: "selected", type: "boolean", required: true },
      { name: "optional", type: "string", required: false },
    ];
    const accepted: Array<Record<string, string | number | boolean>> = [
      { count: 0, selected: false },
      { count: 0, selected: false, optional: "" },
    ];
    for (const content of accepted)
      expect(validateMcpFormResponse(fields, { action: "accept", content })).toBe(true);
    const rejected: Array<Record<string, string | number | boolean>> = [
      { count: "0", selected: false },
      { count: 0.5, selected: false },
      { count: 6, selected: false },
      { count: 0, selected: "false" },
      { count: 0, selected: false, extra: "unknown" },
    ];
    for (const content of rejected)
      expect(validateMcpFormResponse(fields, { action: "accept", content })).toBe(false);
  });

  it("validates a calendar date and date-time with an explicit timezone", () => {
    const day: McpFormField = { name: "day", type: "date", required: true };
    const time: McpFormField = { name: "when", type: "date-time", required: true };
    expect(validateMcpFormValue(day, "2028-02-29")).toBe(true);
    expect(validateMcpFormValue(day, "2026-02-29")).toBe(false);
    expect(validateMcpFormValue(time, "2026-11-20T14:30:00+01:00")).toBe(true);
    expect(validateMcpFormValue(time, "2026-11-20T13:30:00Z")).toBe(true);
    expect(validateMcpFormValue(time, "2026-11-20T14:30:00")).toBe(false);
    expect(validateMcpFormValue(time, "2026-11-20T14:30Z")).toBe(false);
  });

  it("rejects data-bearing refusals and prototype field names", () => {
    const mcpFormId = "719d0947-259b-46dd-af23-96b03ddf3248";
    expect(
      McpFormAnswerSchema.safeParse({ mcpFormId, action: "decline", content: {} }).success,
    ).toBe(false);
    expect(
      McpFormAnswerSchema.safeParse({
        mcpFormId,
        action: "accept",
        content: JSON.parse('{"__proto__":"value"}'),
      }).success,
    ).toBe(false);
  });
});
