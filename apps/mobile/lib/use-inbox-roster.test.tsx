// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useInboxRoster } from "./use-inbox-roster";

const fake = vi.hoisted(() => ({
  foreground: true,
  subscribe: vi.fn(),
  streams: [] as Array<{
    event: (event: { type: "roster"; ready?: true }) => void;
    close: () => void;
    signal: AbortSignal;
  }>,
}));
vi.mock("./api", () => ({ subscribeRosterEvents: fake.subscribe }));
vi.mock("./app-foreground", () => ({ useAppForeground: () => fake.foreground }));

let root: Root;
let container: HTMLDivElement;
function Harness({ run, enabled = true }: { run: () => Promise<unknown>; enabled?: boolean }) {
  useInboxRoster(run, enabled);
  return null;
}
async function render(run: () => Promise<unknown>, enabled = true, key = "account-a") {
  await act(async () => root.render(<Harness key={key} run={run} enabled={enabled} />));
}
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}
function streamAt(index: number) {
  const stream = fake.streams[index];
  if (!stream) throw new Error(`Missing fixture stream ${index}`);
  return stream;
}
async function event(ready = false, index = fake.streams.length - 1) {
  await act(async () =>
    streamAt(index).event({ type: "roster", ...(ready ? { ready: true } : {}) }),
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.foreground = true;
  fake.streams = [];
  fake.subscribe.mockReset().mockImplementation(
    (event, signal) =>
      new Promise<void>((close) => {
        fake.streams.push({ event, signal, close });
        signal.addEventListener("abort", close, { once: true });
      }),
  );
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("loads once on prompt readiness, then reconciles each minute", async () => {
  const run = vi.fn(async () => true);
  await render(run);
  await event(true);
  await advance(59_999);
  expect(run).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(run).toHaveBeenCalledTimes(2);
});

it("retains the 15 second fallback through repeated early stream failures", async () => {
  fake.subscribe.mockRejectedValue(new Error("offline"));
  const run = vi.fn(async () => true);
  await render(run);
  await advance(45_000);
  expect(fake.subscribe.mock.calls.length).toBeGreaterThan(5);
  expect(run).toHaveBeenCalledTimes(4);
});

it("polls with an older server that never advertises roster readiness", async () => {
  const run = vi.fn(async () => true);
  await render(run);
  await advance(30_000);
  expect(run).toHaveBeenCalledTimes(3);
});

it("coalesces bursts and makes one trailing refresh for invalidations during a load", async () => {
  let resolve!: (result: boolean) => void;
  const run = vi.fn<() => Promise<unknown>>().mockResolvedValue(true);
  await render(run);
  await event(true);
  run.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await event();
  await event();
  await advance(100);
  expect(run).toHaveBeenCalledTimes(2);
  await event();
  await event();
  await advance(5_000);
  expect(run).toHaveBeenCalledTimes(2);
  await act(async () => resolve(true));
  await advance(100);
  expect(run).toHaveBeenCalledTimes(3);
});

it("does not postpone a queued refresh while frames keep arriving", async () => {
  const run = vi.fn(async () => true);
  await render(run);
  await event(true);
  await event();
  await advance(50);
  await event();
  await advance(50);
  expect(run).toHaveBeenCalledTimes(2);
});

it("refreshes on late readiness and reconnect, preserving queued invalidation on disconnect", async () => {
  const run = vi.fn(async () => true);
  await render(run);
  await advance(3_000);
  await event(true);
  await advance(100);
  expect(run).toHaveBeenCalledTimes(2);
  await event();
  await act(async () => streamAt(0).close());
  await advance(100);
  expect(run).toHaveBeenCalledTimes(3);
  await advance(900);
  expect(fake.streams).toHaveLength(2);
  await event(true);
  await advance(100);
  expect(run).toHaveBeenCalledTimes(4);
});

it("pauses background work, ignores retired account events, and aborts on unmount", async () => {
  const oldRun = vi.fn(async () => true);
  const newRun = vi.fn(async () => true);
  await render(oldRun);
  fake.foreground = false;
  await render(oldRun);
  expect(streamAt(0).signal.aborted).toBe(true);
  await event();
  await advance(60_000);
  expect(oldRun).toHaveBeenCalledTimes(1);
  fake.foreground = true;
  await render(newRun, true, "account-b");
  await event(false, 0);
  await advance(100);
  expect(newRun).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  expect(streamAt(1).signal.aborted).toBe(true);
  await event();
  await advance(60_000);
  expect(newRun).toHaveBeenCalledTimes(1);
});
