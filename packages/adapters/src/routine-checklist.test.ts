// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AgentRunRequest } from "@orkbot/adapter-kit";
import type { RoutineChecklist } from "@orkbot/contracts";
import { RoutineChecklistSchema } from "@orkbot/contracts";
import { expect, it, vi } from "vitest";
import { createRoutineChecklist, routineChecklistFromPrompt } from "./routine-checklist.js";

const request = (overrides: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  botId: "bot",
  threadId: "thread",
  runId: "run",
  routineId: "routine",
  prompt: "1. Read the report\n2. Save the summary",
  instructions: "",
  history: [],
  tools: [],
  model: { provider: "openai-compatible", id: "fixture" },
  ...overrides,
});

it.each(["1. First\n2. Second", "- First\n- Second", "• First\n• Second", "1) First\n2) Second"])(
  "extracts structured list steps: %s",
  (prompt) => {
    expect(routineChecklistFromPrompt(prompt)?.steps.map((step) => step.text)).toEqual([
      "First",
      "Second",
    ]);
  },
);

it("ignores nested items, code samples, and prompts with fewer than two steps", () => {
  expect(routineChecklistFromPrompt("- First\n  - nested\n- Second")?.steps).toHaveLength(2);
  expect(
    routineChecklistFromPrompt("- First\n- Second\n- [ ]   \n- [ ]\n-   ")?.steps,
  ).toHaveLength(2);
  expect(routineChecklistFromPrompt("```\n- First\n- Second\n```")).toBeUndefined();
  expect(routineChecklistFromPrompt("Read and save the report")).toBeUndefined();
  expect(createRoutineChecklist(request({ routineId: undefined }))).toBeUndefined();
});

it("requires a reason for blocked and skipped outcomes", async () => {
  const tracker = createRoutineChecklist(request())!;
  await expect(
    tracker.request.executeTool!("update_routine_step", { step: 1, status: "blocked" }, "call"),
  ).rejects.toThrow();
  await tracker.request.executeTool!(
    "update_routine_step",
    { step: 1, status: "blocked", reason: "No source file" },
    "call",
  );
  expect(tracker.snapshot().steps[0]).toMatchObject({
    status: "blocked",
    reason: "No source file",
  });
  expect(() =>
    RoutineChecklistSchema.parse({
      ...tracker.snapshot(),
      steps: tracker.snapshot().steps.map((step) => ({ ...step, id: 1 })),
    }),
  ).toThrow();
});

it("persists snapshots in order and keeps recorded outcomes when finishing unresolved work", async () => {
  const onRoutineChecklist = vi.fn(async (_snapshot: RoutineChecklist) => {});
  const tracker = createRoutineChecklist(request({ onRoutineChecklist }))!;
  await tracker.persist();
  await tracker.request.executeTool!("update_routine_step", { step: 1, status: "done" }, "call");
  expect(await tracker.continuationPrompt()).toContain("2. Save the summary");
  expect(tracker.needsContinuation()).toBe(false);
  await tracker.finish();
  expect(tracker.snapshot().steps.map((step) => step.status)).toEqual(["done", "blocked"]);
  expect(onRoutineChecklist.mock.calls.map(([snapshot]) => snapshot.steps[0]?.status)).toEqual([
    "pending",
    "done",
    "done",
    "done",
  ]);
  expect(createRoutineChecklist(request(), tracker.snapshot())?.needsContinuation()).toBe(false);
});
