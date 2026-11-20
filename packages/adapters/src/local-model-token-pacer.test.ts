// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)

import { MODEL_REQUEST_LIMIT_ERROR } from "@orkbot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalModelTokenPacer } from "./local-model-token-pacer.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe("LocalModelTokenPacer", () => {
  it("admits overlapping requests up to the limit and expires at exactly 60 seconds", async () => {
    const pacer = new LocalModelTokenPacer(100, { now: () => Date.now() });
    const [first, second] = await Promise.all([pacer.reserve(60), pacer.reserve(40)]);
    expect([first.waitedMs, second.waitedMs]).toEqual([0, 0]);
    const admitted = vi.fn();
    const pending = pacer.reserve(1).then((reservation) => {
      admitted();
      return reservation;
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(admitted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).waitedMs).toBe(60_000);
    expect(admitted).toHaveBeenCalledOnce();
  });

  it("waits only until sufficient admissions expire in the sliding window", async () => {
    const pacer = new LocalModelTokenPacer(100);
    await pacer.reserve(40);
    await vi.advanceTimersByTimeAsync(10_000);
    await pacer.reserve(60);
    const pending = pacer.reserve(50);
    await vi.advanceTimersByTimeAsync(50_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).waitedMs).toBe(60_000);
  });

  it("preserves FIFO when a smaller request could bypass a blocked request", async () => {
    const pacer = new LocalModelTokenPacer(100);
    const first = await pacer.reserve(80);
    const order: string[] = [];
    const large = pacer.reserve(90).then((reservation) => {
      order.push("large");
      return reservation;
    });
    const small = pacer.reserve(10).then((reservation) => {
      order.push("small");
      return reservation;
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    first.release();
    await Promise.all([large, small]);
    expect(order).toEqual(["large", "small"]);
  });

  it("releases failed reservations immediately and settles them once", async () => {
    const pacer = new LocalModelTokenPacer(100);
    const first = await pacer.reserve(100);
    const pending = pacer.reserve(100);
    await vi.advanceTimersByTimeAsync(1_200);
    first.release();
    first.complete(10);
    first.release();
    expect((await pending).waitedMs).toBe(1_200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces successful reservation weight with reported usage and keeps it until expiry", async () => {
    const pacer = new LocalModelTokenPacer(100);
    const first = await pacer.reserve(80);
    const pending = pacer.reserve(50);
    first.complete(20);
    first.release();
    first.complete(100);
    expect((await pending).waitedMs).toBe(0);
    // Correction is 0.8125; the admitted second request costs ceil(50 * 0.8125) = 41.
    const blocked = pacer.reserve(50);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await blocked).waitedMs).toBe(60_000);
  });

  it("calibrates future estimates upward from successful prompt token reports", async () => {
    const pacer = new LocalModelTokenPacer(100);
    const first = await pacer.reserve(20);
    first.complete(40); // Correction becomes 1.25.
    const second = await pacer.reserve(40); // Costs 50, leaving 10.
    const admitted = vi.fn();
    const pending = pacer.reserve(10).then((reservation) => {
      admitted();
      return reservation;
    }); // Costs 13, so it waits.
    await Promise.resolve();
    expect(admitted).not.toHaveBeenCalled();
    second.release();
    expect((await pending).waitedMs).toBe(0);
  });

  it("bounds calibration even for extreme reported usage", async () => {
    const pacer = new LocalModelTokenPacer(100);
    const first = await pacer.reserve(1);
    first.complete(100_000);
    await vi.advanceTimersByTimeAsync(60_000);
    // The first ratio is clamped to four: 0.75 + 4 * 0.25 = 1.75.
    expect((await pacer.reserve(57)).waitedMs).toBe(0);
    await expect(pacer.reserve(58)).rejects.toThrow(MODEL_REQUEST_LIMIT_ERROR);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
    "ignores invalid reported usage %s",
    async (report) => {
      const pacer = new LocalModelTokenPacer(100);
      const first = await pacer.reserve(60);
      first.complete(report);
      expect((await pacer.reserve(40)).waitedMs).toBe(0);
      const pending = pacer.reserve(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await pending).waitedMs).toBe(60_000);
    },
  );

  it("removes aborted waiters and immediately wakes the next request", async () => {
    const pacer = new LocalModelTokenPacer(100);
    await pacer.reserve(80);
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const rejected = expect(pacer.reserve(90, controller.signal)).rejects.toBe(reason);
    const pending = pacer.reserve(20);
    controller.abort(reason);
    await rejected;
    expect((await pending).waitedMs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects already aborted calls without reserving tokens", async () => {
    const pacer = new LocalModelTokenPacer(100);
    const controller = new AbortController();
    controller.abort();
    await expect(pacer.reserve(100, controller.signal)).rejects.toBe(controller.signal.reason);
    expect((await pacer.reserve(100)).waitedMs).toBe(0);
  });

  it("rejects oversized requests without blocking the FIFO", async () => {
    const pacer = new LocalModelTokenPacer(100);
    await expect(pacer.reserve(101)).rejects.toThrow(MODEL_REQUEST_LIMIT_ERROR);
    expect((await pacer.reserve(100)).waitedMs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects oversized requests even while other requests are queued", async () => {
    const pacer = new LocalModelTokenPacer(100);
    const first = await pacer.reserve(100);
    const pending = pacer.reserve(100);
    await expect(pacer.reserve(101)).rejects.toThrow(MODEL_REQUEST_LIMIT_ERROR);
    first.release();
    expect((await pending).waitedMs).toBe(0);
  });

  it("does not let an expired reservation release or overwrite newer admissions", async () => {
    const pacer = new LocalModelTokenPacer(100);
    const first = await pacer.reserve(100);
    await vi.advanceTimersByTimeAsync(60_000);
    await pacer.reserve(100);
    first.release();
    const pending = pacer.reserve(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).waitedMs).toBe(60_000);
  });
});
