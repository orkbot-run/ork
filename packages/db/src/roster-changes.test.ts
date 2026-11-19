// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { RealtimeFanout } from "@orkbot/adapter-kit";
import { afterEach, expect, it, vi } from "vitest";
import { createRosterChanges } from "./roster-changes.js";

afterEach(() => vi.useRealTimers());

it("coalesces activity and roster changes at their own cadence and unsubscribes on abort", async () => {
  vi.useFakeTimers();
  const listeners = new Map<string, (payload: string) => void>();
  const fanout: RealtimeFanout = {
    describe: () => ({
      id: "fixture",
      adapterVersion: "1",
      contractVersion: "1",
      capabilities: { distributed: true, push: true },
    }),
    async publish(topic, payload) {
      listeners.get(topic)?.(payload);
    },
    async subscribe(topic, receive) {
      listeners.set(topic, receive);
      return async () => {
        listeners.delete(topic);
      };
    },
    async close() {
      listeners.clear();
    },
  };
  const owner = new AbortController();
  const stream = createRosterChanges(fanout).follow(
    { userId: "user", spaceId: "space" },
    owner.signal,
  );
  await expect(stream.next()).resolves.toMatchObject({ value: { type: "roster", ready: true } });
  expect([...listeners.keys()]).toEqual(["roster:user:user", "roster:space:space"]);
  await fanout.publish("roster:user:other", "roster");
  const first = stream.next();
  await fanout.publish("roster:user:user", "activity");
  await expect(first).resolves.toMatchObject({ value: { type: "roster" } });

  const next = vi.fn();
  const changed = stream.next().then(next);
  await fanout.publish("roster:user:user", "activity");
  await fanout.publish("roster:user:user", "activity");
  await vi.advanceTimersByTimeAsync(2_999);
  expect(next).not.toHaveBeenCalled();
  await fanout.publish("roster:space:space", "roster");
  await vi.advanceTimersByTimeAsync(1);
  expect(next).toHaveBeenCalledExactlyOnceWith({ value: { type: "roster" }, done: false });
  await changed;

  const activity = vi.fn();
  const streamed = stream.next().then(activity);
  await fanout.publish("roster:user:user", "activity");
  await vi.advanceTimersByTimeAsync(9_999);
  expect(activity).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(activity).toHaveBeenCalledExactlyOnceWith({ value: { type: "roster" }, done: false });
  await streamed;

  const closing = stream.next();
  owner.abort();
  await expect(closing).resolves.toMatchObject({ done: true });
  expect(listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
