// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HEARTBEAT_MS, SESSION_RECHECK_MS } from "./routes/shared.js";
import { sessionStream } from "./session-stream.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const event = (value: number): IteratorResult<number> => ({ done: false, value });
function fixture() {
  const controller = new AbortController();
  const read = deferred<IteratorResult<number>>();
  const source = {
    next: vi.fn(() => read.promise),
    return: vi.fn(async () => ({ done: true as const, value: undefined })),
  };
  const stillAuthorized = vi.fn(async () => true);
  let sourceSignal: AbortSignal | undefined;
  const project = vi.fn(async (value: number) => ({ type: "data" as const, value }));
  const open = vi.fn((signal: AbortSignal) => {
    sourceSignal = signal;
    return { source, heartbeat: () => ({ type: "beat" as const }), project };
  });
  const stream = sessionStream({ signal: controller.signal, stillAuthorized }, open);
  return {
    controller,
    read,
    source,
    stillAuthorized,
    project,
    open,
    stream,
    signal: () => sourceSignal,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("keeps one pending read across heartbeats, retaining event order and wire values", async () => {
  const h = fixture();
  const first = h.stream.next();
  await flush();
  await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
  expect(await first).toEqual({ done: false, value: { type: "beat" } });
  const second = h.stream.next();
  await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
  expect(await second).toEqual({ done: false, value: { type: "beat" } });
  expect(h.source.next).toHaveBeenCalledOnce();
  const third = h.stream.next();
  h.read.resolve(event(7));
  expect(await third).toEqual({ done: false, value: { type: "data", value: 7 } });
  expect(h.source.next).toHaveBeenCalledOnce();
  await h.stream.return();
  expect(h.source.return).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("retires authorization and source even while the consumer is paused at a yielded value", async () => {
  const h = fixture();
  h.read.resolve(event(7));
  expect((await h.stream.next()).value).toEqual({ type: "data", value: 7 });
  h.stillAuthorized.mockResolvedValue(false);
  await vi.advanceTimersByTimeAsync(SESSION_RECHECK_MS);
  expect(h.signal()?.aborted).toBe(true);
  expect(h.source.return).toHaveBeenCalledOnce();
  await expect(h.stream.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(vi.getTimerCount()).toBe(0);
});

it("does not publish an event while a due authorization read is unresolved", async () => {
  const h = fixture();
  const authorized = deferred<boolean>();
  h.stillAuthorized.mockReturnValue(authorized.promise);
  const next = h.stream.next();
  const rejected = expect(next).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await flush();
  await vi.advanceTimersByTimeAsync(SESSION_RECHECK_MS);
  h.read.resolve(event(7));
  await flush();
  expect(h.project).not.toHaveBeenCalled();
  authorized.resolve(false);
  await rejected;
  expect(h.source.return).toHaveBeenCalledOnce();
});

it("does not publish a completed projection until a due authorization read succeeds", async () => {
  const h = fixture();
  const authorized = deferred<boolean>();
  const projected = deferred<{ type: "data"; value: number }>();
  h.stillAuthorized.mockReturnValue(authorized.promise);
  h.project.mockReturnValue(projected.promise);
  h.read.resolve(event(7));
  let delivered = false;
  const next = h.stream.next().then((value) => {
    delivered = true;
    return value;
  });
  await flush();
  await vi.advanceTimersByTimeAsync(SESSION_RECHECK_MS);
  projected.resolve({ type: "data", value: 7 });
  await flush();
  expect(delivered).toBe(false);
  authorized.resolve(true);
  expect((await next).value).toEqual({ type: "data", value: 7 });
  await h.stream.return();
});

it("aborts a blocked projection and ignores its late completion", async () => {
  const h = fixture();
  const projected = deferred<{ type: "data"; value: number }>();
  h.project.mockReturnValue(projected.promise);
  h.read.resolve(event(7));
  const next = h.stream.next();
  await flush();
  h.controller.abort();
  expect(await next).toEqual({ done: true, value: undefined });
  projected.resolve({ type: "data", value: 7 });
  await flush();
  expect(await h.stream.next()).toEqual({ done: true, value: undefined });
  expect(h.source.return).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("closes a late-opened source after abort without starting its read", async () => {
  const controller = new AbortController();
  const opened = deferred<{
    source: AsyncIterator<number>;
    heartbeat: () => number;
    project: (value: number) => number;
  }>();
  const source = {
    next: vi.fn(async () => event(7)),
    return: vi.fn(() => new Promise<IteratorResult<number>>(() => {})),
  };
  const stream = sessionStream({ signal: controller.signal }, () => opened.promise);
  const next = stream.next();
  await flush();
  controller.abort();
  expect(await next).toEqual({ done: true, value: undefined });
  opened.resolve({ source, heartbeat: () => 0, project: (value) => value });
  await flush();
  expect(source.next).not.toHaveBeenCalled();
  expect(source.return).toHaveBeenCalledOnce();
});

it.each(["already", "queued"])("does not open a source after %s abort", async (when) => {
  const h = fixture();
  if (when === "already") h.controller.abort();
  const next = h.stream.next();
  if (when === "queued") h.controller.abort();
  expect(await next).toEqual({ done: true, value: undefined });
  expect(h.open).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves source errors even when teardown throws", async () => {
  const h = fixture();
  const failed = new Error("source unavailable");
  h.source.return.mockImplementation(() => {
    throw new Error("close unavailable");
  });
  const next = h.stream.next();
  const rejected = expect(next).rejects.toBe(failed);
  await flush();
  h.read.reject(failed);
  await rejected;
  expect(h.signal()?.aborted).toBe(true);
  expect(h.source.return).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("finishes a completed source, removes its parent listener and closes once", async () => {
  const h = fixture();
  const remove = vi.spyOn(h.controller.signal, "removeEventListener");
  h.read.resolve({ done: true, value: undefined });
  expect(await h.stream.next()).toEqual({ done: true, value: undefined });
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  await h.stream.return();
  expect(h.source.return).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores late authorization and source rejection after abort", async () => {
  const h = fixture();
  const authorization = deferred<boolean>();
  h.stillAuthorized.mockReturnValue(authorization.promise);
  const next = h.stream.next();
  await flush();
  await vi.advanceTimersByTimeAsync(SESSION_RECHECK_MS);
  h.controller.abort();
  expect(await next).toEqual({ done: true, value: undefined });
  authorization.reject(new Error("late auth error"));
  h.read.reject(new Error("late read error"));
  await flush();
  expect(h.source.return).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves an active authorization error and closes its source", async () => {
  const h = fixture();
  const failure = new Error("authorization unavailable");
  h.stillAuthorized.mockRejectedValueOnce(failure);
  const rejected = expect(h.stream.next()).rejects.toBe(failure);
  await flush();
  await vi.advanceTimersByTimeAsync(SESSION_RECHECK_MS);
  await rejected;
  expect(h.signal()?.aborted).toBe(true);
  expect(h.source.return).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("aborts before a consumer throw queues behind a blocked read", async () => {
  const h = fixture();
  const failure = new Error("consumer closed");
  const next = expect(h.stream.next()).rejects.toBe(failure);
  await flush();
  const thrown = expect(h.stream.throw(failure)).rejects.toBe(failure);
  await Promise.all([next, thrown]);
  expect(h.signal()?.aborted).toBe(true);
  expect(h.source.return).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
