// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AgentRunRequest, ConnectorTool } from "@orkbot/adapter-kit";
import type { RoutineChecklist } from "@orkbot/contracts";
import { RoutineChecklistSchema, RoutineChecklistStepSchema } from "@orkbot/contracts";
import { redactSecrets } from "@orkbot/core";
import { automated } from "./automated-messages.js";

export const ROUTINE_STEP_TOOL = "update_routine_step";

/** Top-level Markdown list items only; nested items belong to their containing step. */
export function routineChecklistFromPrompt(prompt: string): RoutineChecklist | undefined {
  const lines = prompt.replace(/```[\s\S]*?```/g, "").split(/\r?\n/);
  const items = lines.flatMap((line) => {
    const match = /^(\s*)(?:\d+[.)]|[-*+•])\s+(?:\[[ xX]\]\s*)?(.+)$/.exec(line);
    const text = match?.[2]?.trim();
    return match && text && !/^\[[ xX]\]$/.test(text) ? [{ indent: match[1]!.length, text }] : [];
  });
  const indent = Math.min(...items.map((item) => item.indent));
  const steps = items.filter((item) => item.indent === indent);
  if (steps.length < 2 || steps.length > 100 || steps.some((step) => step.text.length > 4000))
    return undefined;
  return {
    steps: steps.map(({ text }, index) => ({
      id: index + 1,
      text,
      status: "pending",
      reason: null,
    })),
    continuationRequested: false,
  };
}

const stepTool: ConnectorTool = {
  name: ROUTINE_STEP_TOOL,
  description:
    "Record a routine checklist step after doing it, or explain why it is blocked or intentionally skipped. Never mark a promise as done.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      step: { type: "integer", minimum: 1 },
      status: { type: "string", enum: ["done", "blocked", "skipped"] },
      reason: { type: "string", minLength: 1, maxLength: 1000 },
    },
    required: ["step", "status"],
    additionalProperties: false,
  },
};

export function createRoutineChecklist(request: AgentRunRequest, restored?: RoutineChecklist) {
  if (!request.routineId) return undefined;
  // A parallel sibling may finish after the human-pause checkpoint was captured.
  // The latest fenced durable event includes that result and supersedes the checkpoint.
  let snapshot = request.routineChecklist ?? restored ?? routineChecklistFromPrompt(request.prompt);
  if (!snapshot) return undefined;
  snapshot = RoutineChecklistSchema.parse(snapshot);
  // Parallel model tool calls must publish snapshots in the order their updates were made.
  let writes = Promise.resolve();
  const persist = () => {
    const current = structuredClone(snapshot!);
    writes = writes.then(() => request.onRoutineChecklist?.(current));
    return writes;
  };
  const open = () => snapshot!.steps.filter((step) => step.status === "pending");
  return {
    snapshot: () => structuredClone(snapshot!),
    persist,
    needsContinuation: () => !snapshot!.continuationRequested && open().length > 0,
    async continuationPrompt() {
      const steps = open()
        .map((step) => `${step.id}. ${step.text}`)
        .join("\n");
      snapshot = { ...snapshot!, continuationRequested: true };
      await persist();
      return automated(
        `The routine still has unaccounted steps:\n${steps}\nContinue the work and record each step with ${ROUTINE_STEP_TOOL}: done, blocked with a concrete reason, or skipped with a concrete reason. Respect the latest user instructions, approvals and limits. Ask if you need input. Do not finish with an unperformed promise.`,
      );
    },
    async finish() {
      if (!open().length) return;
      snapshot = {
        ...snapshot!,
        steps: snapshot!.steps.map((step) =>
          step.status === "pending"
            ? {
                ...step,
                status: "blocked",
                reason: "The run ended without recording an outcome for this step.",
              }
            : step,
        ),
      };
      await persist();
    },
    request: {
      ...request,
      tools: [...request.tools.filter((tool) => tool.name !== ROUTINE_STEP_TOOL), stepTool],
      instructions: `${request.instructions}\n\nRoutine checklist:\n${snapshot.steps.map((step) => `${step.id}. ${step.text} [${step.status}]`).join("\n")}\nAfter working on each step, call ${ROUTINE_STEP_TOOL} to record done, blocked(reason), or skipped(reason). Account for every step before finishing.`,
      executeTool: async (
        ...[name, args, executionId, route, observer]: Parameters<
          NonNullable<AgentRunRequest["executeTool"]>
        >
      ) => {
        if (name !== ROUTINE_STEP_TOOL) {
          if (!request.executeTool) throw new Error("Tool executor unavailable");
          return request.executeTool(name, args, executionId, route, observer);
        }
        const prior = snapshot!.steps.find((step) => step.id === args.step);
        if (!prior || !["done", "blocked", "skipped"].includes(String(args.status)))
          throw new Error("Unknown routine step or invalid terminal status");
        const next = RoutineChecklistStepSchema.parse({
          ...prior,
          status: args.status,
          reason: args.status === "done" ? null : args.reason,
        });
        snapshot = {
          ...snapshot!,
          steps: snapshot!.steps.map((step) => (step.id === next.id ? next : step)),
        };
        await persist();
        return { step: next.id, status: next.status, reason: next.reason };
      },
    } satisfies AgentRunRequest,
  };
}

export function redactRoutineChecklist(
  checklist: RoutineChecklist,
  secrets: readonly string[],
): RoutineChecklist {
  return {
    ...checklist,
    steps: checklist.steps.map((step) => ({
      ...step,
      text: redactSecrets(step.text, secrets),
      reason: step.reason === null ? null : redactSecrets(step.reason, secrets),
    })),
  };
}
