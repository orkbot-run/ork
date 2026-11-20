// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited cache probes are preserved. Turn-memory evaluation follows LICENSE.md.

import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AgentRunModel,
  AgentRunRequest,
  AgentRuntime,
} from "@orkbot/adapter-kit";
import {
  currentTurnMemoryBlock,
  userTurnInstructions,
} from "../../../adapters/src/run-instructions.js";
import type { CacheDecisionMeasurement, EvalPricing, MeasuredCall } from "./measurement.js";
import { measureCalls } from "./measurement.js";

export type CacheProbeMode = "prefix" | "turn-memory";

type ProbePhase = Pick<AgentRunRequest, "prompt" | "instructions" | "history"> & {
  phase: string;
};

const PROBE_PROMPT = "Reply only PROBE-OK.";

function prefixPhases(experiment: string): ProbePhase[] {
  const observations = Array.from(
    { length: 240 },
    (_, i) =>
      `Neutral synthetic observation ${i}: preserve the requested output; take no external actions.`,
  ).join("\n");
  return ["fresh-prefix", "same-prefix-replay", "changed-prefix", "changed-prefix-replay"].map(
    (phase, index) => ({
      phase,
      instructions: `Synthetic cache probe ${experiment} cohort ${index < 2 ? "A" : "B"}.\n${observations}`,
      prompt: PROBE_PROMPT,
      history: [],
    }),
  );
}

function turnMemoryPhases(experiment: string): ProbePhase[] {
  const history = Array.from({ length: 8 }, (_, index) => [
    {
      role: "user" as const,
      content: `Review synthetic shipment ${index} and record the destination and delivery window.`,
    },
    {
      role: "assistant" as const,
      content: Array.from(
        { length: 8 },
        (_, row) =>
          `Shipment ${index}, row ${row}: confirmed the destination of the sample parcel and its delivery window.`,
      ).join("\n"),
    },
  ]).flat();
  return ["system", "turn"].flatMap((placement) =>
    ["warmup", "replay", "memory-changed"].map((stage) => {
      const turnMemoryInPrompt = placement === "turn";
      const memory = `Synthetic durable memory: destination changed to ${stage === "memory-changed" ? "London" : "Berlin"}.`;
      const scratchpad = `Synthetic scratchpad: next window is ${stage === "memory-changed" ? "Friday" : "Monday"}.`;
      return {
        phase: `${placement}-${stage}`,
        instructions: userTurnInstructions({
          botInstructions: `Synthetic cache probe ${experiment}, cohort ${placement}.`,
          groupContext: undefined,
          messagingContext: undefined,
          redactedMemoryContext: memory,
          redactedScratchpadContext: scratchpad,
          turnMemoryInPrompt,
          hasHistoricalContext: false,
          computerInstruction: "The test uses text only.",
          pageBrowserAllowed: false,
          workspaceInstruction: "Only synthetic records are available.",
          agentEnvironmentInstruction: undefined,
          botDirectory: undefined,
          pluginLine: undefined,
          agentSkillsLine: undefined,
          taughtSkillsLine: undefined,
          replyGuidance: "Keep the reply short.",
        })
          .filter(Boolean)
          .join("\n\n"),
        prompt: turnMemoryInPrompt
          ? `${PROBE_PROMPT}\n\n${currentTurnMemoryBlock(memory, scratchpad)}`
          : PROBE_PROMPT,
        history,
      };
    }),
  );
}

/** Controlled prefix replay, not a retention-time test. No keepalive requests are issued. */
export async function runCachePrefixProbe(
  runtime: AgentRuntime,
  model: AgentRunModel,
  pricing: EvalPricing,
  decisions: readonly CacheDecisionMeasurement[] = [],
  mode: CacheProbeMode = "prefix",
) {
  const experiment = randomUUID();
  const scope = {
    operationId: "synthetic-cache-probe",
    traceId: "synthetic-cache-probe",
    spaceId: experiment,
    userId: experiment,
  };
  const phases = mode === "turn-memory" ? turnMemoryPhases(experiment) : prefixPhases(experiment);
  const maxOutputTokens = mode === "turn-memory" ? 64 : 256;
  const rows = [];
  for (const { phase, prompt, instructions, history } of phases) {
    const calls = new Map<string, MeasuredCall>();
    const firstDecision = decisions.length;
    const runId = randomUUID();
    const collect = (event: Parameters<NonNullable<AgentRunRequest["onUsage"]>>[0]) => {
      calls.set(event.callId ?? "single-probe-call", {
        id: event.callId ?? "single-probe-call",
        ...event,
        operation: event.operationKind ?? "setup",
      });
    };
    const started = Date.now();
    let failed = false;
    let firstResponseMs: number | null = null;
    const context: AdapterContext = { ...scope, signal: AbortSignal.timeout(60000) };
    try {
      for await (const event of runtime.run(
        {
          botId: experiment,
          threadId: experiment,
          runId,
          contextStrategy: "current",
          usageOperationKind: "setup",
          allowSilentEmpty: mode === "turn-memory",
          prompt,
          instructions,
          history,
          tools: [],
          model: { ...model, maxTokens: maxOutputTokens, thinkingLevel: "minimal" },
          onUsage: collect,
        },
        context,
      )) {
        if (event.type === "text" && firstResponseMs === null)
          firstResponseMs = Date.now() - started;
        if (event.type === "usage") collect(event);
      }
    } catch {
      failed = true;
    } finally {
      await runtime.abort(runId);
    }
    // A retry may warm a different prefix and would distort the comparison.
    failed ||= calls.size === 0 || (mode === "turn-memory" && calls.size !== 1);
    rows.push({
      phase,
      failed,
      latencyMs: Date.now() - started,
      firstResponseMs,
      cacheDecisions: decisions.slice(firstDecision),
      ...measureCalls([...calls.values()], pricing, model.cacheCapabilities?.minimumTokens),
    });
    if (failed) break; // Never continue after a failed reservation or incomplete provider call.
  }
  const systemReads = rows.find(
    (row) => row.phase === "system-memory-changed" && !row.failed,
  )?.cacheReadTokens;
  const turnReads = rows.find(
    (row) => row.phase === "turn-memory-changed" && !row.failed,
  )?.cacheReadTokens;
  return {
    fixtureVersion: mode === "turn-memory" ? "cache-turn-memory-v1" : "cache-prefix-v1",
    modelLimits: { contextWindow: model.contextWindow ?? null, maxOutputTokens },
    retentionExperiment: false,
    cacheState:
      mode === "turn-memory"
        ? "Warm up independent prefixes for memory in system instructions and memory in the current turn. Replay each once unchanged, then change memory and scratchpad with all prior messages fixed."
        : "Fresh random prefix then immediate identical replay; change prefix and replay again. Provider routing and cache state are not controlled.",
    ...(mode === "turn-memory"
      ? {
          memoryChange: {
            systemCacheReadTokens: systemReads ?? null,
            turnCacheReadTokens: turnReads ?? null,
            additionalCacheReadTokens:
              typeof systemReads === "number" && typeof turnReads === "number"
                ? turnReads - systemReads
                : null,
          },
        }
      : {}),
    phases: rows,
    modelCalls: rows.reduce((n, r) => n + r.modelCalls, 0),
    costUsd:
      rows.length && rows.every((r) => r.costUsd !== null)
        ? rows.reduce((n, r) => n + r.costUsd!, 0)
        : null,
  };
}
