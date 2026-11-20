// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited cache-probe coverage is preserved. Turn-memory coverage follows LICENSE.md.

import type { AgentRunRequest, AgentRuntime } from "@orkbot/adapter-kit";
import { expect, it, vi } from "vitest";
import { runCachePrefixProbe } from "./cache-probe.js";

const model = { provider: "fixture", id: "fixture" };
const pricing = {
  source: "fixture",
  version: "v1",
  input: 1,
  output: 2,
  cacheRead: 0.1,
  cacheWrite: 3,
};

function fixture(cachedTokens: readonly number[] = []) {
  const requests: AgentRunRequest[] = [];
  const abort = vi.fn(async () => {});
  const runtime = {
    abort,
    describe: vi.fn(),
    async *run(request: AgentRunRequest) {
      const cacheReadTokens = cachedTokens[requests.length] ?? 0;
      requests.push(request);
      const usage = {
        type: "usage" as const,
        provider: "fixture",
        model: "fixture",
        callId: "single",
        operationKind: request.usageOperationKind,
        inputTokens: 100 - cacheReadTokens,
        outputTokens: 10,
        cacheReadTokens,
        cacheWriteTokens: 0,
        totalTokens: 110,
      };
      await request.onUsage?.(usage);
      yield { type: "text" as const, text: "PROBE-OK" };
      yield usage;
    },
  } as AgentRuntime;
  return { runtime, requests, abort };
}

it("replays exact prefixes and changes them without inferring a retention deadline", async () => {
  const { runtime, requests, abort } = fixture();
  const report = await runCachePrefixProbe(runtime, model, pricing);
  const instructions = requests.map((request) => request.instructions);
  expect(report.modelCalls).toBe(4); // Producer sink and consumer stream do not double count.
  expect(instructions[0]).toBe(instructions[1]);
  expect(instructions[2]).toBe(instructions[3]);
  expect(instructions[0]).not.toBe(instructions[2]);
  expect(report.retentionExperiment).toBe(false);
  expect(report.costUsd).toBeCloseTo(0.00048);
  for (const phase of report.phases) {
    expect(phase.operationCosts.setup).toBe(phase.costUsd);
    expect(phase.operationCosts.answer).toBe(0);
    expect(phase.modelCalls).toBe(1);
  }
  expect(abort).toHaveBeenCalledTimes(4);
});

it("compares the cache reads after the same memory change in each placement", async () => {
  const { runtime, requests } = fixture([0, 99, 15, 0, 99, 80]);
  const report = await runCachePrefixProbe(runtime, model, pricing, [], "turn-memory");
  expect(report.modelCalls).toBe(6);
  const [system, systemReplay, systemChanged, turn, turnReplay, turnChanged] = requests;
  expect(systemChanged!.instructions).not.toBe(system!.instructions);
  expect(system!.instructions).toBe(systemReplay!.instructions);
  expect(turn!.instructions).toBe(turnReplay!.instructions);
  expect(turn!.instructions).toBe(turnChanged!.instructions);
  expect(turn!.prompt).toBe(turnReplay!.prompt);
  expect(turnChanged!.prompt).toContain("London");
  expect(turnChanged!.prompt).toContain("Friday");
  expect(turnChanged!.prompt).not.toContain("Berlin");
  expect(systemChanged!.history).toEqual(turnChanged!.history);
  expect(JSON.stringify(turnChanged!.history)).not.toContain("Synthetic durable memory:");
  expect(report.memoryChange).toEqual({
    systemCacheReadTokens: 15,
    turnCacheReadTokens: 80,
    additionalCacheReadTokens: 65,
  });
});
