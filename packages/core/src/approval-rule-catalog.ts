// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ActionApprovalRule, BuiltinToolName } from "@orkbot/contracts";
import { BUILTIN_TOOL_NAMES, isBuiltinToolName, READ_ONLY_AGENT_TOOLS } from "@orkbot/contracts";
import type { ApprovalMode } from "./action-approval.js";
import { toolRequiresExplicitApproval } from "./action-approval.js";
import { humanizeToolName, toolNameFromLabel } from "./events.js";

export type ApprovalRuleEffect = ActionApprovalRule["effect"];

/** Stable built-in identities, with the same labels on every client. */
export const APPROVAL_RULE_TOOLS: readonly { name: BuiltinToolName; label: string }[] =
  BUILTIN_TOOL_NAMES.map((name) => ({ name, label: humanizeToolName(name) }));

export function approvalRuleTool(name: string) {
  const normalized = toolNameFromLabel(name).toLowerCase();
  return APPROVAL_RULE_TOOLS.find((tool) => tool.name === normalized);
}

/** Host-computer permission is granted separately, not by an Allow or Ask rule. */
export function hasSeparateComputerApproval(name: string): boolean {
  return ["user_computer_shell", "user_computer_observe", "user_computer_act"].includes(
    name.toLowerCase(),
  );
}

/** Only choices the runtime can honor. Unknown tools retain integration-rule compatibility. */
export function approvalRuleEffects(
  name: string,
  mode: ApprovalMode,
): readonly ApprovalRuleEffect[] {
  const normalized = name.toLowerCase();
  if (hasSeparateComputerApproval(normalized)) return ["deny"];
  return [
    ...(isBuiltinToolName(normalized) && toolRequiresExplicitApproval(normalized)
      ? []
      : ["always_allow" as const]),
    ...(mode === "never" || READ_ONLY_AGENT_TOOLS.has(normalized)
      ? []
      : ["require_approval" as const]),
    "deny",
  ];
}

export function initialApprovalRuleEffect(name: string, mode: ApprovalMode): ApprovalRuleEffect {
  const effects = approvalRuleEffects(name, mode);
  return effects.includes("require_approval") ? "require_approval" : "deny";
}
