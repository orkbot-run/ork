// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it } from "vitest";
import { mcpFormContent } from "./mcp-form";

describe("mcpFormContent", () => {
  it("keeps false distinct from omitted booleans and converts numeric fields only", () => {
    expect(
      mcpFormContent(
        [
          { name: "flag", type: "boolean", required: true },
          { name: "absent", type: "boolean", required: false },
          { name: "number", type: "number", required: true },
          { name: "text", type: "string", required: true },
          { name: "optional", type: "email", required: false },
        ],
        { flag: false, number: "1.5", text: "001", optional: "" },
      ),
    ).toEqual({ flag: false, number: 1.5, text: "001" });
  });
  it("keeps an explicitly selected empty enum option", () => {
    expect(
      mcpFormContent(
        [{ name: "choice", type: "enum", required: true, options: [{ value: "", label: "None" }] }],
        { choice: "" },
      ),
    ).toEqual({ choice: "" });
  });
});
