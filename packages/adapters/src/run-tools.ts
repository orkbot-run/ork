// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited dispatch remains Apache-2.0; Ork self-target and replay taint guards are PolyForm-covered.

import type { AgentToolExecutionObserver } from "@orkbot/adapter-kit";
import { toolResultTaintsRun } from "@orkbot/core";
import { isTerminatingReplyResult } from "./approval-effect.js";
import { IMAGE_RETURNING_COMPUTER_TOOLS, MODEL_CANNOT_SEE_MESSAGE } from "./model-vision.js";
import type { RunContext } from "./run-context.js";
import { noteComputerTaskStep } from "./run-progress.js";
import type { ToolHandler } from "./run-tool-gate.js";
import { auditToolCall, gateToolCall } from "./run-tool-gate.js";
import { prepareToolRequest, resolveToolRequest } from "./run-tool-request.js";
import { backgroundHelperToolAllowed, PAGE_BROWSER_TOOL_NAMES } from "./run-tool-selection.js";
import { computerTools, pageBrowserTool } from "./run-tools-computer.js";
import { feedbackTools } from "./run-tools-feedback.js";
import { fileTools } from "./run-tools-files.js";
import { fleetTools } from "./run-tools-fleet.js";
import { cloudAgentTool, connectorTool, integrationTools } from "./run-tools-integrations.js";
import { memoryTools } from "./run-tools-memory.js";
import { messagingTools } from "./run-tools-messaging.js";
import { pageTools } from "./run-tools-pages.js";
import { preferenceTools } from "./run-tools-preferences.js";
import { purchaseTools } from "./run-tools-purchases.js";
import { secretTools } from "./run-tools-secrets.js";
import { taskTools } from "./run-tools-tasks.js";
import {
  USER_COMPUTER_ACT_TOOL,
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_SHELL_TOOL,
  userComputerAct,
  userComputerObserve,
  userComputerShell,
} from "./run-tools-user-computer.js";
import { strategicInitiativeToolAllowed } from "./strategic-initiative.js";
import { argumentGiven, normalizeOwnBotTarget } from "./update-bot-patch.js";

const TOOL_HANDLERS = new Map<string, ToolHandler>([
  ...Object.entries(computerTools),
  ...Object.entries(fileTools),
  ...Object.entries(pageTools),
  ...Object.entries(memoryTools),
  ...Object.entries(integrationTools),
  ...Object.entries(taskTools),
  ...Object.entries(messagingTools),
  ...Object.entries(secretTools),
  ...Object.entries(fleetTools),
  [USER_COMPUTER_SHELL_TOOL, userComputerShell],
  [USER_COMPUTER_OBSERVE_TOOL, userComputerObserve],
  [USER_COMPUTER_ACT_TOOL, userComputerAct],
  ...Object.entries(purchaseTools),
  ...Object.entries(preferenceTools),
  ...Object.entries(feedbackTools),
  ...[...PAGE_BROWSER_TOOL_NAMES].map((name) => [name, pageBrowserTool] as const),
]);

function toolHandler(name: string): ToolHandler {
  return (
    TOOL_HANDLERS.get(name) ?? (name.startsWith("cloud_agent_") ? cloudAgentTool : connectorTool)
  );
}

/** Run one tool call of this run's model: gate it, then hand it to its tool family. */
export async function applyTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  _route?: unknown,
  observer?: AgentToolExecutionObserver,
) {
  if (name === "update_bot") args = normalizeOwnBotTarget(args, ctx.bot.id);
  let resolvedArgs = args;
  try {
    ctx.context.signal.throwIfAborted();
    // Enforce the helper boundary before request preparation, including connector lookup.
    if (
      !backgroundHelperToolAllowed(ctx.run.trigger, name) ||
      (ctx.run.trigger === "background_helper" && ctx.tools.connector.has(name))
    ) {
      return { error: "This tool is unavailable to background helpers." };
    }
    if (!strategicInitiativeToolAllowed(name, ctx.run)) {
      return { error: "Daily check-ins can only ask or message the user." };
    }
    if (ctx.state.handedOff) {
      return {
        error: "This stage was handed off. End the turn without more tool calls.",
      };
    }
    if (ctx.tools.disabled.has(name)) {
      return { error: "This tool is disabled for this bot." };
    }
    if (PAGE_BROWSER_TOOL_NAMES.has(name) && !ctx.computer.pageBrowserAllowed) {
      return { error: "Page browser is unavailable on this computer." };
    }
    if (IMAGE_RETURNING_COMPUTER_TOOLS.has(name) && !ctx.computer.acceptsImages) {
      return { error: MODEL_CANNOT_SEE_MESSAGE };
    }
    const request = await resolveToolRequest(ctx, name, args, executionId);
    if ("error" in request) return request;
    resolvedArgs = request.args;
    const refused = await prepareToolRequest(ctx, request);
    resolvedArgs = request.args;
    if (refused) return refused;
    noteComputerTaskStep(ctx.state.reply, request.name);
    const gate = await gateToolCall(ctx, request, observer);
    if ("result" in gate) return gate.result;
    if (!gate.call.applied) return await toolHandler(gate.call.name)(ctx, gate.call);
    let outcome: "success" | "failure" = "failure";
    try {
      const result = await toolHandler(gate.call.name)(ctx, gate.call);
      if (!isToolError(result)) outcome = "success";
      return result;
    } finally {
      await auditToolCall(ctx, gate.call.name, outcome, {
        effectId: gate.call.applied.effect.id,
        autoApproved: gate.call.bypassApproval,
      });
    }
  } finally {
    // A replay's stored target decides whether the result came from this bot or another one.
    const ownProfile = name === "update_bot" && !argumentGiven(resolvedArgs.bot_id);
    // Starting a durable helper returns only its id; the eventual helper output is
    // separately marked as outside content when it enters the parent run.
    const backgroundStart = name === "run_subagent" && resolvedArgs.background === true;
    if (toolResultTaintsRun(name) && !ownProfile && !backgroundStart) ctx.state.tainted = true;
  }
}

export function isToolError(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  if ("error" in result) return true;
  return isTerminatingReplyResult(result);
}
