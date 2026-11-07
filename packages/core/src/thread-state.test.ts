// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ProductEvent, Run, ThreadSnapshot } from "@orkbot/contracts";
import { expect, it } from "vitest";
import { threadWindowMessages } from "./message-pages.js";
import {
  applyThreadSendReceipt,
  mergeThreadSnapshot,
  reconcileRefreshedThread,
  reduceThreadSnapshot,
  rememberTerminalThreadRun,
} from "./thread-state.js";

const now = "2026-01-01T00:00:00.000Z";
const run: Run = {
  id: "run",
  botId: "bot",
  threadId: "thread",
  taskId: "task",
  userId: "owner",
  status: "running",
  trigger: "routine",
  routineId: "routine",
  modelProvider: "connection",
  modelId: "model",
  error: null,
  startedAt: now,
  completedAt: null,
  createdAt: now,
};
function snapshot(): ThreadSnapshot {
  return {
    threadId: "thread",
    botId: "bot",
    cursor: 0,
    olderCursor: null,
    messages: [],
    run: null,
  };
}
function event(type: string, seq: number, payload: Record<string, unknown> = {}): ProductEvent {
  return {
    id: `event-${seq}`,
    spaceId: "space",
    botId: "bot",
    threadId: "thread",
    runId: "run",
    createdAt: now,
    type,
    seq,
    payload,
  } as ProductEvent;
}

it("preserves complete known run metadata through start, wait and release", () => {
  const initial = { ...snapshot(), run, activeRuns: [run] };
  const started = reduceThreadSnapshot(initial, event("run.started", 1))!;
  expect(started.run).toEqual(run);
  const waiting = reduceThreadSnapshot(started, event("computer.takeover.requested", 2))!;
  expect(waiting.run).toEqual({ ...run, status: "waiting_takeover" });
  const released = reduceThreadSnapshot(waiting, event("computer.takeover.released", 3))!;
  expect(released.run).toEqual({ ...run, status: "queued" });
  expect(released.activeRuns).toEqual([released.run]);
});

it("keeps persisted message seq independent of its stream cursor and ignores older/foreign events", () => {
  const started = reduceThreadSnapshot(snapshot(), event("run.started", 1))!;
  const progress = reduceThreadSnapshot(started, event("thread.progress", 2, { text: "Working" }))!;
  const created = reduceThreadSnapshot(
    progress,
    event("thread.message.created", 4, {
      messageId: "message",
      seq: 2,
      role: "bot",
      blocks: [{ kind: "text", text: "Done" }],
    }),
  )!;
  expect(created.messages).toHaveLength(1);
  expect(created.messages[0]).toMatchObject({ id: "message", seq: 2, threadId: "thread" });
  expect(created.cursor).toBe(4);
  const ended = reduceThreadSnapshot(created, event("run.completed", 5))!;
  expect(ended.run).toBeNull();
  expect(reduceThreadSnapshot(ended, event("run.started", 3))).toBe(ended);
  expect(reduceThreadSnapshot(ended, event("thread.progress", 5))).toBe(ended);
  expect(reduceThreadSnapshot(ended, { ...event("thread.cleared", 6), threadId: "other" })).toBe(
    ended,
  );
  expect(ended.messages[0]?.id).toBe("message");
});

it("preserves a waiting secondary group run on same-cursor refresh and accepts a later release", () => {
  const other = { ...run, id: "other", botId: "peer" };
  const computer = {
    state: "running" as const,
    mode: "team" as const,
    controlHolder: "bot" as const,
    screenAvailable: true,
    busyBotName: "Fixture",
  };
  const current = {
    ...snapshot(),
    groupId: "group",
    cursor: 2,
    run: other,
    activeRuns: [other, { ...run, status: "waiting_takeover" }],
    computer,
  };
  const fetched = { ...current, activeRuns: [other, run] };
  const result = reconcileRefreshedThread(current, fetched, computer);
  expect(result.snapshot.run).toBe(other);
  expect(result.snapshot.activeRuns?.find((candidate) => candidate.id === "run")).toEqual({
    ...run,
    status: "waiting_takeover",
  });
  expect(result.snapshot.computer?.busyBotName).toBeNull();
  const released = reconcileRefreshedThread(
    result.snapshot,
    { ...fetched, cursor: 3 },
    result.computer,
  );
  expect(released.snapshot.activeRuns).toEqual([other, run]);
  expect(released.computer?.busyBotName).toBe("Fixture");
});

it("keeps accepted sends queued during a failed refresh while a terminal event always wins over its late receipt", () => {
  const receipt = { botId: "bot", runId: "run", taskId: "task", createdAt: now };
  const queued = applyThreadSendReceipt(snapshot(), receipt)!;
  expect(queued.run).toMatchObject({ id: "run", taskId: "task", status: "queued" });
  expect(queued.activeRuns).toEqual([queued.run]);
  const terminals = new Set<string>();
  const endedEvent = event("run.completed", 1);
  rememberTerminalThreadRun(terminals, endedEvent);
  const ended = reduceThreadSnapshot(queued, endedEvent)!;
  expect(applyThreadSendReceipt(ended, receipt, terminals)).toBe(ended);
  expect(ended.run).toBeNull();
  expect(applyThreadSendReceipt({ ...snapshot(), groupId: "group" }, receipt)?.run).toBeNull();
  expect(applyThreadSendReceipt({ ...snapshot(), botId: "other" }, receipt)?.run).toBeNull();
});

it("does not replace active work and retains paused cards when accepting another send", () => {
  const receipt = { botId: "bot", runId: "next", taskId: "next-task", createdAt: now };
  const busy = { ...snapshot(), run, activeRuns: [run] };
  expect(applyThreadSendReceipt(busy, receipt)).toBe(busy);
  const paused = { ...run, status: "waiting_input" as const };
  const accepted = applyThreadSendReceipt(
    { ...snapshot(), run: paused, activeRuns: [paused] },
    receipt,
  )!;
  expect(accepted.activeRuns?.map((candidate) => candidate.id)).toEqual(["run", "next"]);
  expect(accepted.activeRuns?.[0]).toBe(paused);
});

it("retains terminal receipt fences only for terminal events with known IDs", () => {
  const terminals = new Set<string>();
  rememberTerminalThreadRun(terminals, event("run.started", 1));
  expect(terminals.size).toBe(0);
  for (let index = 0; index < 101; index++)
    rememberTerminalThreadRun(terminals, {
      ...event("run.cancelled", index),
      runId: `run-${index}`,
    });
  expect(terminals.size).toBe(100);
  expect(terminals.has("run-0")).toBe(false);
  expect(terminals.has("run-100")).toBe(true);
});

it("never invents a durable message seq from a full event's independent replay cursor", () => {
  const created = reduceThreadSnapshot(
    snapshot(),
    event("thread.message.created", 81, {
      messageId: "legacy-message",
      role: "bot",
      blocks: [{ kind: "text", text: "Done" }],
    }),
  )!;
  expect(created.cursor).toBe(81);
  expect(created.messages[0]?.seq).toBeUndefined();
  const known = { ...created, messages: [{ ...created.messages[0]!, seq: 7 }] };
  const updated = reduceThreadSnapshot(
    known,
    event("thread.message.updated", 82, {
      messageId: "legacy-message",
      role: "bot",
      blocks: [{ kind: "text", text: "Updated" }],
    }),
  )!;
  expect(updated.cursor).toBe(82);
  expect(updated.messages[0]?.seq).toBe(7);
  expect(threadWindowMessages(created.messages, 7)).toEqual([]);
  expect(threadWindowMessages(created.messages, null)).toEqual(created.messages);
  const hydrated = mergeThreadSnapshot(
    created,
    { ...created, messages: [{ ...created.messages[0]!, seq: 7 }] },
    true,
  );
  expect(hydrated.messages).toHaveLength(1);
  expect(hydrated.messages[0]?.seq).toBe(7);
});

it("keeps a secondary takeover's cleared busy state when the refresh cursor is older", () => {
  const other = { ...run, id: "other", botId: "peer" };
  const computer = {
    state: "running" as const,
    mode: "team" as const,
    controlHolder: "bot" as const,
    screenAvailable: true,
    busyBotName: null,
  };
  const current = {
    ...snapshot(),
    groupId: "group",
    cursor: 10,
    run: other,
    activeRuns: [other, { ...run, status: "waiting_takeover" }],
    computer,
  };
  const old = {
    ...current,
    cursor: 9,
    activeRuns: [other, run],
    computer: { ...computer, busyBotName: "Fixture" },
  };
  const result = reconcileRefreshedThread(current, old, computer);
  expect(result.snapshot.cursor).toBe(10);
  expect(result.snapshot.run).toBe(other);
  expect(result.snapshot.activeRuns).toBe(current.activeRuns);
  expect(result.snapshot.computer?.busyBotName).toBeNull();
  expect(result.computer?.busyBotName).toBeNull();
});
