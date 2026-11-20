// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { MessageBlock } from "@orkbot/contracts";

export function callSpeechCompletion(blocks: readonly MessageBlock[]) {
  const text = blocks
    .flatMap((block) =>
      block.kind === "text" || (block.kind === "ask" && block.status !== "answered")
        ? [block.text]
        : [],
    )
    .join("\n")
    .trim();
  const append = blocks.some((block) =>
    block.kind === "text"
      ? block.callSpeechContinues
      : block.kind === "ask" && block.status !== "answered",
  );
  return { text, append };
}

const ABBREVIATIONS = new Set([
  "dr",
  "mr",
  "mrs",
  "ms",
  "prof",
  "sr",
  "jr",
  "st",
  "vs",
  "etc",
  "e.g",
  "i.e",
  "np",
  "itd",
  "itp",
  "tj",
  "tzn",
  "ul",
  "al",
  "im",
  "mgr",
  "inż",
  "hab",
  "godz",
  "min",
  "ok",
  "m.in",
  "tzw",
  "św",
  "nr",
  "art",
  "ust",
  "pkt",
]);
const TAIL_LIMIT = 240;

function normalizedText(text: string): string {
  return text.replace(/\s+/gu, " ").trimStart();
}

function hasSpeechContent(text: string): boolean {
  return /[\p{L}\p{N}\p{S}]/u.test(text);
}

/** Cumulative text tracker. Clients call flush on a timer and finish at stream completion. */
export class CallSpeechText {
  private text = "";
  private earlierSegments = "";
  private consumed = "";
  private finished = false;

  update(text: string, segmentStart = 0): string[] {
    if (this.finished) return [];
    this.text = normalizedText(text);
    this.earlierSegments = normalizedText(text.slice(0, segmentStart));
    if (!this.text.startsWith(this.consumed)) return [];
    const chunks: string[] = [];
    const tail = this.text.slice(this.consumed.length);
    const ends = /[.!?。！？…]+["'”’»）)\]]*/gu;
    let from = 0;
    for (const match of tail.matchAll(ends)) {
      const end = match.index + match[0].length;
      // A period arriving as the last token may still become a decimal or abbreviation.
      if (end === tail.length) break;
      if (match[0].startsWith(".")) {
        if (/\d/u.test(tail[match.index - 1] ?? "") && /\d/u.test(tail[end] ?? "")) continue;
        const word = tail.slice(0, match.index).match(/([\p{L}.]+)$/u)?.[1] ?? "";
        if (ABBREVIATIONS.has(word.toLowerCase()) || /^\p{Lu}$/u.test(word)) continue;
        if (!/\s/u.test(tail[end] ?? "")) continue;
      }
      const chunk = tail.slice(from, end).trim();
      if (hasSpeechContent(chunk)) chunks.push(chunk);
      from = end;
    }
    this.consumed += tail.slice(0, from);
    return chunks;
  }

  /** Emit a bounded whole-word tail, retaining an incomplete last word. */
  flush(): string[] {
    if (this.finished || !this.text.startsWith(this.consumed)) return [];
    const tail = this.text.slice(this.consumed.length);
    if (tail.length <= TAIL_LIMIT && /[.!?。！？…]["'”’»）)\]]*\s*$/u.test(tail)) {
      const word = tail.match(/([\p{L}.]+)\.["'”’»）)\]]*\s*$/u)?.[1] ?? "";
      if (!ABBREVIATIONS.has(word.toLowerCase()) && !/^\p{Lu}$/u.test(word)) {
        this.consumed = this.text;
        return hasSpeechContent(tail) ? [tail.trim()] : [];
      }
    }
    const window = tail.slice(0, TAIL_LIMIT + 1);
    const end = window.lastIndexOf(" ");
    if (end < 1) return [];
    const chunk = tail.slice(0, end).trim();
    this.consumed += tail.slice(0, end);
    return hasSpeechContent(chunk) ? [chunk] : [];
  }

  finish(text?: string, append = false): string[] {
    if (this.finished) return [];
    if (text !== undefined) {
      const final = normalizedText(text);
      this.text = append
        ? normalizedText(`${this.text} ${final}`)
        : !this.earlierSegments || final.startsWith(this.earlierSegments)
          ? final
          : this.earlierSegments + final;
    }
    this.finished = true;
    // Already-spoken text cannot be taken back. On a rewritten prefix, do not replay it.
    if (!this.text.startsWith(this.consumed)) return [];
    const tail = this.text.slice(this.consumed.length).trim();
    this.consumed = this.text;
    return hasSpeechContent(tail) ? [tail] : [];
  }
}

export interface CallSpeechQueueOptions<T> {
  render(text: string, signal: AbortSignal): Promise<T>;
  play(clip: T, text: string, signal: AbortSignal): Promise<void>;
}

type Rendered<T> = { text: string; clip: T } | undefined;

/** Ordered speech playback with one render prefetched during playback. */
export class CallSpeechQueue<T> {
  readonly settled: Promise<void>;
  private readonly abort = new AbortController();
  private readonly pending: string[] = [];
  private resolve!: () => void;
  private reject!: (error: unknown) => void;
  private prefetched: Promise<Rendered<T>> | undefined;
  private running = false;
  private playing = false;
  private closed = false;
  private done = false;

  constructor(private readonly options: CallSpeechQueueOptions<T>) {
    this.settled = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // Playback may fail before the caller reaches finish(). Keep that rejection observed.
    void this.settled.catch(() => {});
  }

  add(chunks: readonly string[]): void {
    if (this.closed || this.done) return;
    this.pending.push(...chunks.filter((text) => text.trim()));
    if (this.playing) this.prefetch();
    if (!this.running && this.pending.length) {
      this.running = true;
      void this.run();
    }
  }

  finish(): Promise<void> {
    this.closed = true;
    if (!this.running && !this.done) this.complete();
    return this.settled;
  }

  cancel(): void {
    if (this.done) return;
    this.complete();
    this.abort.abort();
    this.pending.length = 0;
    this.prefetched = undefined;
  }

  private complete(): void {
    this.done = true;
    this.resolve();
  }

  private fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.pending.length = 0;
    this.reject(error);
    this.abort.abort();
  }

  private render(text: string): Promise<Rendered<T>> {
    return Promise.resolve()
      .then(() => (this.done ? undefined : this.options.render(text, this.abort.signal)))
      .then((clip) => (this.done ? undefined : { text, clip: clip as T }))
      .catch((error: unknown) => {
        this.fail(error);
        return undefined;
      });
  }

  private prefetch(): void {
    if (this.done || this.prefetched) return;
    const text = this.pending.shift();
    if (text !== undefined) this.prefetched = this.render(text);
  }

  private async run(): Promise<void> {
    try {
      while (!this.done) {
        this.prefetch();
        const rendering = this.prefetched;
        this.prefetched = undefined;
        if (!rendering) break;
        const ready = await rendering;
        if (!ready || this.done) break;
        this.playing = true;
        this.prefetch();
        await this.options.play(ready.clip, ready.text, this.abort.signal);
        this.playing = false;
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.playing = false;
      this.running = false;
      if (this.closed && !this.done) this.complete();
    }
  }
}

export interface CallSpeechSink {
  add(chunks: readonly string[]): void;
  finish(): Promise<void>;
  cancel(): void;
  readonly settled?: Promise<void>;
}

/** A single streamed assistant reply, with lazy audio setup and bounded tail latency. */
export class CallSpeechTurn {
  readonly settled: Promise<void>;
  private readonly text = new CallSpeechText();
  private sink: CallSpeechSink | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private done = false;
  private resolve!: () => void;
  private reject!: (error: unknown) => void;

  constructor(
    private readonly createSink: () => CallSpeechSink,
    private readonly options: { flushDelayMs?: number } = {},
  ) {
    this.settled = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    void this.settled.catch(() => {});
  }

  update(text: string, segmentStart?: number): void {
    if (this.closed) return;
    this.add(this.text.update(text, segmentStart));
    this.scheduleFlush();
  }

  finish(text?: string, append = false): Promise<void> {
    if (this.closed) return this.settled;
    this.closed = true;
    this.clearTimer();
    this.add(this.text.finish(text, append));
    if (!this.done) {
      try {
        void (this.sink?.finish() ?? Promise.resolve()).then(
          () => this.complete(),
          (error: unknown) => this.fail(error),
        );
      } catch (error) {
        this.fail(error);
      }
    }
    return this.settled;
  }

  cancel(): void {
    if (this.done) return;
    this.closed = true;
    this.clearTimer();
    this.sink?.cancel();
    this.complete();
  }

  private add(chunks: string[]): void {
    if (this.done || !chunks.length) return;
    try {
      if (!this.sink) {
        this.sink = this.createSink();
        void this.sink.settled?.catch((error: unknown) => this.fail(error));
      }
      this.sink.add(chunks);
    } catch (error) {
      this.fail(error);
    }
  }

  private scheduleFlush(): void {
    if (this.closed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed) return;
      const chunks = this.text.flush();
      this.add(chunks);
      // Long tails continue in bounded pieces; an incomplete word waits for another update.
      if (chunks.length) this.scheduleFlush();
    }, this.options.flushDelayMs ?? 450);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private complete(): void {
    if (this.done) return;
    this.done = true;
    this.resolve();
  }

  private fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.closed = true;
    this.clearTimer();
    this.sink?.cancel();
    this.reject(error);
  }
}
