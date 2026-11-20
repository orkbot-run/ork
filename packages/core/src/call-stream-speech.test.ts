// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it, vi } from "vitest";
import { CallSpeechQueue, CallSpeechText, CallSpeechTurn } from "./call-stream-speech.js";

describe("CallSpeechText", () => {
  it("emits sentences once across cumulative partial punctuation and decimal tokens", () => {
    const text = new CallSpeechText();
    expect(text.update("Koszt to 3.")).toEqual([]);
    expect(text.update("Koszt to 3.14 zł. Dalej")).toEqual(["Koszt to 3.14 zł."]);
    expect(text.update("Koszt to 3.14 zł. Dalej")).toEqual([]);
    expect(text.finish("Koszt to 3.14 zł. Dalej idziemy.")).toEqual(["Dalej idziemy."]);
    expect(text.finish()).toEqual([]);
  });

  it("retains common abbreviations and initials, supports Unicode punctuation and quotes", () => {
    const text = new CallSpeechText();
    expect(text.update("Dr. A. Kowalski zna np. ten lek. „Tak!” 你好。次は？ ")).toEqual([
      "Dr. A. Kowalski zna np. ten lek.",
      "„Tak!”",
      "你好。",
      "次は？",
    ]);
    expect(text.finish()).toEqual([]);
  });

  it("flushes whole words while retaining split words and deduplicates final output", () => {
    const text = new CallSpeechText();
    expect(text.update("Hello there incom")).toEqual([]);
    expect(text.flush()).toEqual(["Hello there"]);
    expect(text.flush()).toEqual([]);
    expect(text.update("Hello there incomplete phrase. Next")).toEqual(["incomplete phrase."]);
    expect(text.finish("Hello there incomplete phrase. Next sentence.")).toEqual([
      "Next sentence.",
    ]);
  });

  it("bounds timed tails and handles whitespace changes", () => {
    const text = new CallSpeechText();
    text.update("  words  ".repeat(100));
    const chunks = text.flush();
    expect(chunks[0]?.length).toBeLessThanOrEqual(240);
    const end = text.finish("words ".repeat(100));
    expect([...chunks, ...end].join(" ")).toBe("words ".repeat(100).trim());
  });

  it("does not synthesize punctuation that arrives after a timed word flush", () => {
    const text = new CallSpeechText();
    text.update("Hello world ");
    expect(text.flush()).toEqual(["Hello world"]);
    expect(text.update("Hello world. Next")).toEqual([]);
    expect(text.finish("Hello world. Next.")).toEqual(["Next."]);
    const final = new CallSpeechText();
    final.update("Hello world ");
    final.flush();
    expect(final.finish("Hello world.")).toEqual([]);
  });

  it("accepts edits in unspoken text and conservatively suppresses rewritten spoken prefixes", () => {
    const text = new CallSpeechText();
    text.update("First draft");
    expect(text.update("Better draft. More")).toEqual(["Better draft."]);
    expect(text.update("Changed draft. More")).toEqual([]);
    expect(text.finish("Changed draft. More text.")).toEqual([]);
  });

  it("keeps a complete sentence intact when the model pauses just after the period", () => {
    const text = new CallSpeechText();
    expect(text.update("Already completed.")).toEqual([]);
    expect(text.flush()).toEqual(["Already completed."]);
    expect(text.finish("Already completed. Still more.")).toEqual(["Still more."]);
  });

  it("matches the durable answer against the newest segment after tool activity", () => {
    const text = new CallSpeechText();
    const earlier = "I will check.\n\n";
    expect(text.update(`${earlier}It worked. Here`, earlier.length)).toEqual([
      "I will check.",
      "It worked.",
    ]);
    expect(text.finish("It worked. Here is the result.")).toEqual(["Here is the result."]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function tick() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("CallSpeechTurn", () => {
  it("creates audio lazily and flushes after a fixed delay despite ongoing deltas", async () => {
    vi.useFakeTimers();
    try {
      const sink = { add: vi.fn(), finish: vi.fn(async () => {}), cancel: vi.fn() };
      const factory = vi.fn(() => sink);
      const turn = new CallSpeechTurn(factory);
      turn.update("A useful");
      expect(factory).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      turn.update("A useful ongoing");
      await vi.advanceTimersByTimeAsync(150);
      expect(sink.add).toHaveBeenCalledExactlyOnceWith(["A useful"]);
      await turn.finish("A useful ongoing reply.");
      expect(sink.add.mock.calls.map(([chunks]) => chunks)).toEqual([
        ["A useful"],
        ["ongoing reply."],
      ]);
      expect(sink.finish).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not spin on a partial word and cancels timers before audio exists", async () => {
    vi.useFakeTimers();
    try {
      const factory = vi.fn(() => ({ add: vi.fn(), finish: async () => {}, cancel: vi.fn() }));
      const turn = new CallSpeechTurn(factory);
      turn.update("incomplete");
      await vi.advanceTimersByTimeAsync(450);
      expect(vi.getTimerCount()).toBe(0);
      expect(factory).not.toHaveBeenCalled();
      turn.update("incomplete word");
      turn.cancel();
      await turn.finish("incomplete word.");
      await vi.advanceTimersByTimeAsync(1000);
      expect(factory).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains the lazy sink once, forwards early failures, and cancels an active turn", async () => {
    const drain = deferred<void>();
    const sink = { add: vi.fn(), finish: vi.fn(() => drain.promise), cancel: vi.fn() };
    const turn = new CallSpeechTurn(() => sink);
    turn.update("Hello. Next");
    const finished = turn.finish("Hello. Next.");
    expect(turn.finish()).toBe(finished);
    expect(sink.finish).toHaveBeenCalledOnce();
    turn.cancel();
    await finished;
    expect(sink.cancel).toHaveBeenCalledOnce();
    drain.reject(new Error("late drain"));
    await tick();

    const failed = deferred<void>();
    const failedTurn = new CallSpeechTurn(() => ({
      add: vi.fn(),
      finish: async () => {},
      cancel: vi.fn(),
      settled: failed.promise,
    }));
    failedTurn.update("Hello. ");
    failed.reject(new Error("audio failed"));
    await expect(failedTurn.settled).rejects.toThrow("audio failed");
  });
});

describe("CallSpeechQueue", () => {
  it("starts rendering immediately, prefetches one ahead, and finishes only after playback", async () => {
    const plays = [deferred<void>(), deferred<void>(), deferred<void>()];
    const render = vi.fn(async (text: string) => `clip:${text}`);
    let index = 0;
    const play = vi.fn(() => plays[index++]!.promise);
    const queue = new CallSpeechQueue({ render, play });
    queue.add(["one", "two", "three"]);
    const finished = vi.fn();
    void queue.finish().then(finished);
    await tick();
    expect(render.mock.calls.map(([text]) => text)).toEqual(["one", "two"]);
    expect(play.mock.calls).toHaveLength(1);
    expect(finished).not.toHaveBeenCalled();
    plays[0]!.resolve();
    await tick();
    expect(render.mock.calls.map(([text]) => text)).toEqual(["one", "two", "three"]);
    expect(play.mock.calls).toHaveLength(2);
    plays[1]!.resolve();
    await tick();
    plays[2]!.resolve();
    await queue.settled;
    expect(finished).toHaveBeenCalledOnce();
  });

  it("prefetches additions during playback and resumes after an idle gap", async () => {
    const firstPlay = deferred<void>();
    const render = vi.fn(async (text: string) => text);
    const play = vi.fn(async (_clip: string, text: string) => {
      if (text === "one") await firstPlay.promise;
    });
    const queue = new CallSpeechQueue({ render, play });
    queue.add(["one"]);
    await tick();
    queue.add(["two", "three"]);
    await tick();
    expect(render.mock.calls.map(([text]) => text)).toEqual(["one", "two"]);
    firstPlay.resolve();
    await tick();
    queue.add(["four"]);
    await queue.finish();
    expect(play.mock.calls.map(([, text]) => text)).toEqual(["one", "two", "three", "four"]);
  });

  it("cancels pending rendering without waiting for a provider that ignores abort", async () => {
    const rendering = deferred<string>();
    let signal: AbortSignal | undefined;
    const play = vi.fn(async () => {});
    const queue = new CallSpeechQueue({
      render: async (_text, passed) => {
        signal = passed;
        return rendering.promise;
      },
      play,
    });
    queue.add(["one", "two"]);
    await tick();
    queue.cancel();
    await queue.finish();
    expect(signal?.aborted).toBe(true);
    rendering.resolve("late");
    await tick();
    expect(play).not.toHaveBeenCalled();
  });

  it("aborts playback and prefetch together, and observes late failures", async () => {
    const rendering = deferred<string>();
    const playback = deferred<void>();
    const signals: AbortSignal[] = [];
    const queue = new CallSpeechQueue({
      render: async (text, signal) => {
        signals.push(signal);
        return text === "two" ? rendering.promise : text;
      },
      play: async (_clip, _text, signal) => {
        signals.push(signal);
        return playback.promise;
      },
    });
    queue.add(["one", "two", "three"]);
    await tick();
    queue.cancel();
    await queue.finish();
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    rendering.reject(new Error("late render"));
    playback.reject(new Error("late play"));
    await tick();
  });

  it("reports prefetched render failure immediately and aborts active playback", async () => {
    const playback = deferred<void>();
    let signal: AbortSignal | undefined;
    const queue = new CallSpeechQueue({
      render: async (text) => {
        if (text === "two") throw new Error("render failed");
        return text;
      },
      play: async (_clip, _text, passed) => {
        signal = passed;
        return playback.promise;
      },
    });
    queue.add(["one", "two"]);
    await expect(queue.settled).rejects.toThrow("render failed");
    expect(signal?.aborted).toBe(true);
    await expect(queue.finish()).rejects.toThrow("render failed");
    playback.resolve();
  });

  it("propagates playback failures and finishes empty queues", async () => {
    const queue = new CallSpeechQueue({
      render: async (text) => text,
      play: async () => {
        throw new Error("play failed");
      },
    });
    queue.add(["one"]);
    await expect(queue.finish()).rejects.toThrow("play failed");
    await new CallSpeechQueue({ render: async (text) => text, play: async () => {} }).finish();
  });
});
