// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntimeEvent } from "@orkbot/adapter-kit";
import { PiAgentRuntime } from "@orkbot/adapters";
import type { RoutineChecklist } from "@orkbot/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { DENIED_ACTION_ERROR } from "../../adapters/src/approval-effect.js";
import { startModelEmulator } from "./model-emulator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const read = {
  name: "list_files",
  description: "List files",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
function request(
  model: AgentRunRequest["model"],
  overrides: Partial<AgentRunRequest> = {},
): AgentRunRequest {
  return {
    botId: "fixture-bot",
    threadId: "fixture-thread",
    runId: randomUUID(),
    prompt: "Inspect the directory",
    instructions: "Complete the task",
    history: [],
    tools: [read],
    model,
    ...overrides,
  };
}
async function collect(input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(input)) events.push(event);
  return events;
}

it("continues a Polish promise with tools and preserves its narration in chat", async () => {
  const server = await startModelEmulator({
    steps: [
      { expect() {}, response: { type: "text", text: "Sprawdzę katalog teraz." } },
      {
        expect: (wire) => {
          expect(JSON.stringify(wire.messages.at(-1))).toContain("promised an action");
        },
        response: { type: "tool", id: "read-1", name: "list_files", arguments: { path: "." } },
      },
      { expect() {}, response: { type: "text", text: "Katalog sprawdzony." } },
    ],
  });
  cleanups.push(() => server.close());
  const executeTool = vi.fn(async () => ({ files: ["report.txt"] }));
  const events = await collect(request(server.model, { executeTool }));
  server.assertComplete();
  expect(server.requests).toHaveLength(3);
  expect(executeTool).toHaveBeenCalledOnce();
  expect(events.findIndex((event) => event.type === "turn" && event.narration)).toBeLessThan(
    events.findIndex((event) => event.type === "tool"),
  );
  expect(events.some((event) => event.type === "turn" && event.narration)).toBe(true);
  expect(
    events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join(""),
  ).toBe("Sprawdzę katalog teraz.Katalog sprawdzony.");
});

it("bounds repeated empty promises to two consecutive nudges", async () => {
  const server = await startModelEmulator({
    steps: Array.from({ length: 3 }, () => ({
      expect() {},
      response: { type: "text" as const, text: "I'll inspect the directory now." },
    })),
  });
  cleanups.push(() => server.close());
  await collect(request(server.model));
  server.assertComplete();
  expect(server.requests).toHaveLength(3);
});

it("resets the nudge limit after tool execution", async () => {
  const server = await startModelEmulator({
    steps: [
      { expect() {}, response: { type: "text", text: "I'll check the directory." } },
      { expect() {}, response: { type: "text", text: "I'll inspect it now." } },
      {
        expect() {},
        response: { type: "tool", id: "read-1", name: "list_files", arguments: { path: "." } },
      },
      { expect() {}, response: { type: "text", text: "I'll check the second directory." } },
      { expect() {}, response: { type: "text", text: "I'll inspect that now." } },
      { expect() {}, response: { type: "text", text: "Finished." } },
    ],
  });
  cleanups.push(() => server.close());
  await collect(request(server.model, { executeTool: async () => ({ files: [] }) }));
  server.assertComplete();
  expect(server.requests).toHaveLength(6);
});

it("does not reset the nudge limit after Pi rejects an unknown tool", async () => {
  const server = await startModelEmulator({
    steps: [
      { expect() {}, response: { type: "text", text: "I'll check the directory." } },
      { expect() {}, response: { type: "text", text: "I'll inspect it now." } },
      {
        expect() {},
        response: { type: "tool", id: "unknown-1", name: "unknown_tool", arguments: {} },
      },
      { expect() {}, response: { type: "text", text: "I'll check the directory again." } },
    ],
  });
  cleanups.push(() => server.close());
  const executeTool = vi.fn(async () => ({ files: [] }));
  await collect(request(server.model, { executeTool }));
  server.assertComplete();
  expect(server.requests).toHaveLength(4);
  expect(executeTool).not.toHaveBeenCalled();
});

it.each([undefined, "routine"])(
  "does not nudge after an approval is denied (%s)",
  async (routineId) => {
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "read-denied",
            name: "list_files",
            arguments: { path: "." },
          },
        },
        {
          expect() {},
          response: { type: "text", text: "Approval was declined. I'll check another way." },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events = await collect(
      request(server.model, {
        routineId,
        ...(routineId ? { prompt: "- Inspect files\n- Save summary" } : {}),
        executeTool: async () => ({ error: DENIED_ACTION_ERROR }),
      }),
    );
    server.assertComplete();
    expect(events.some((event) => event.type === "turn" && event.narration)).toBe(false);
  },
);

it.each([
  "I'll inspect it. Shall I continue?",
  "Nie mogę kontynuować bez zgody.",
  "I need your approval before proceeding.",
])("keeps interaction boundaries in control: %s", async (text) => {
  const server = await startModelEmulator({
    steps: [{ expect() {}, response: { type: "text", text } }],
  });
  cleanups.push(() => server.close());
  await collect(request(server.model));
  server.assertComplete();
  expect(server.requests).toHaveLength(1);
});

it("nudges a checklist once and persists every explicit step outcome", async () => {
  const snapshots: RoutineChecklist[] = [];
  const server = await startModelEmulator({
    steps: [
      {
        expect() {},
        response: {
          type: "tool",
          id: "step-1",
          name: "update_routine_step",
          arguments: { step: 1, status: "done" },
        },
      },
      {
        expect() {},
        response: {
          type: "tool",
          id: "step-2",
          name: "update_routine_step",
          arguments: { step: 2, status: "done" },
        },
      },
      { expect() {}, response: { type: "text", text: "Inspected and saved the summary." } },
      {
        expect(wire) {
          const nudge = JSON.stringify(wire.messages.at(-1));
          expect(nudge).toContain("3. Send report");
          expect(nudge).not.toMatch(/1\. Inspect files|2\. Save summary/);
        },
        response: {
          type: "tool",
          id: "step-3",
          name: "update_routine_step",
          arguments: { step: 3, status: "skipped", reason: "There is no recipient." },
        },
      },
      {
        expect() {},
        response: { type: "text", text: "Inspection complete; summary skipped as requested." },
      },
    ],
  });
  cleanups.push(() => server.close());
  const executeTool = vi.fn(async () => ({ ok: true }));
  await collect(
    request(server.model, {
      routineId: "routine",
      prompt: "1. Inspect files\n2. Save summary\n3. Send report",
      executeTool,
      onRoutineChecklist: async (value) => {
        snapshots.push(value);
      },
    }),
  );
  server.assertComplete();
  expect(executeTool).not.toHaveBeenCalled();
  expect(snapshots.at(-1)).toMatchObject({
    continuationRequested: true,
    steps: [
      { status: "done", reason: null },
      { status: "done", reason: null },
      { status: "skipped", reason: "There is no recipient." },
    ],
  });
});

it("does not invent completion for routine steps omitted after its one nudge", async () => {
  const snapshots: RoutineChecklist[] = [];
  const server = await startModelEmulator({
    steps: [
      { expect() {}, response: { type: "text", text: "Finished." } },
      { expect() {}, response: { type: "text", text: "Finished." } },
    ],
  });
  cleanups.push(() => server.close());
  await collect(
    request(server.model, {
      routineId: "routine",
      prompt: "- Inspect files\n- Save summary",
      onRoutineChecklist: async (value) => {
        snapshots.push(value);
      },
    }),
  );
  server.assertComplete();
  expect(server.requests).toHaveLength(2);
  expect(snapshots.at(-1)?.steps.map((step) => step.status)).toEqual(["blocked", "blocked"]);
  expect(snapshots.at(-1)?.steps.every((step) => !!step.reason)).toBe(true);
});

it("checks open routine steps even when the provider ends silently", async () => {
  const snapshots: RoutineChecklist[] = [];
  const server = await startModelEmulator({
    steps: [
      { expect() {}, response: { type: "text", text: "" } },
      {
        expect(wire) {
          expect(JSON.stringify(wire.messages.at(-1))).toContain("unaccounted steps");
        },
        response: { type: "text", text: "No changes." },
      },
    ],
  });
  cleanups.push(() => server.close());
  await collect(
    request(server.model, {
      routineId: "routine",
      prompt: "- Inspect files\n- Save summary",
      allowSilentEmpty: true,
      onRoutineChecklist: async (value) => {
        snapshots.push(value);
      },
    }),
  );
  server.assertComplete();
  expect(snapshots.at(-1)?.continuationRequested).toBe(true);
});

it("does not hide a provider failure behind a continuation", async () => {
  const server = await startModelEmulator({
    steps: [
      {
        expect() {},
        response: { type: "error", status: 400, message: "Invalid provider request" },
      },
    ],
  });
  cleanups.push(() => server.close());
  await expect(
    collect(
      request(server.model, { routineId: "routine", prompt: "- Inspect files\n- Save summary" }),
    ),
  ).rejects.toThrow();
  server.assertComplete();
  expect(server.requests).toHaveLength(1);
});
