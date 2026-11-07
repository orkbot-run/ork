// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { BUILTIN_TOOL_NAMES } from "@orkbot/contracts";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_RULE_TOOLS,
  approvalRuleEffects,
  approvalRuleTool,
  initialApprovalRuleEffect,
} from "./approval-rule-catalog.js";
import { humanizeToolName } from "./events.js";

describe("approval rule catalog", () => {
  it("uses every stable built-in identity exactly once with the shared display label", () => {
    expect(APPROVAL_RULE_TOOLS.map((tool) => tool.name)).toEqual([...BUILTIN_TOOL_NAMES]);
    expect(new Set(APPROVAL_RULE_TOOLS.map((tool) => tool.name)).size).toBe(
      BUILTIN_TOOL_NAMES.length,
    );
    for (const tool of APPROVAL_RULE_TOOLS) expect(tool.label).toBe(humanizeToolName(tool.name));
    expect(approvalRuleTool(" Write file ")?.name).toBe("write_file");
    expect(approvalRuleTool("write_fiel")).toBeUndefined();
  });

  it("offers Ask only where an explicit rule can create an approval", () => {
    for (const tool of ["read_file", "web_fetch", "schedule_list"])
      expect(approvalRuleEffects(tool, "ask")).toEqual(["always_allow", "deny"]);
    for (const tool of ["write_file", "shell"])
      expect(approvalRuleEffects(tool, "ask")).toEqual([
        "always_allow",
        "require_approval",
        "deny",
      ]);
  });

  it("does not offer an ineffective Allow on a mandatory built-in", () => {
    expect(approvalRuleEffects("create_space", "auto")).toEqual(["require_approval", "deny"]);
    expect(approvalRuleEffects("create_space", "never")).toEqual(["deny"]);
  });

  it("leaves native host access to its own approval rather than silently setting ineffective rules", () => {
    for (const tool of ["user_computer_shell", "user_computer_observe", "user_computer_act"])
      for (const mode of ["ask", "auto", "never"] as const)
        expect(approvalRuleEffects(tool, mode)).toEqual(["deny"]);
  });

  it("explains Never ask through the actual choices while preserving integration and site identities", () => {
    expect(approvalRuleEffects("read_file", "never")).toEqual(["always_allow", "deny"]);
    expect(approvalRuleEffects("mcp__notes__write", "ask")).toEqual([
      "always_allow",
      "require_approval",
      "deny",
    ]);
    expect(approvalRuleEffects("example.test", "never")).toEqual(["always_allow", "deny"]);
    expect(initialApprovalRuleEffect("read_file", "never")).toBe("deny");
  });
});
