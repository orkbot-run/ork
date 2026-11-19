// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)

import { MODEL_REQUEST_LIMIT_ERROR } from "@orkbot/core";

const WINDOW_MS = 60_000;

export type LocalModelTokenReservation = {
  waitedMs: number;
  complete(actualInputTokens?: number): void;
  release(): void;
};

type Admission = { admittedAt: number; tokens: number };
type Waiter = {
  estimatedTokens: number;
  queuedAt: number;
  resolve: (reservation: LocalModelTokenReservation) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

/** A FIFO input-token budget shared by callers of one local model endpoint. */
export class LocalModelTokenPacer {
  private readonly now: () => number;
  private admissions: Admission[] = [];
  private readonly waiters: Waiter[] = [];
  private correction = 1;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly tokensPerMinute: number,
    options: { now?: () => number } = {},
  ) {
    if (!Number.isFinite(tokensPerMinute) || tokensPerMinute < 1) {
      throw new RangeError("tokensPerMinute must be finite and at least one");
    }
    this.now = options.now ?? Date.now;
  }

  reserve(estimatedTokens: number, signal?: AbortSignal): Promise<LocalModelTokenReservation> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) {
      return Promise.reject(new RangeError("estimatedTokens must be finite and positive"));
    }
    if (Math.ceil(estimatedTokens * this.correction) > this.tokensPerMinute) {
      return Promise.reject(new Error(MODEL_REQUEST_LIMIT_ERROR));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { estimatedTokens, queuedAt: this.now(), resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          this.detach(waiter);
          reject(signal.reason);
          this.drain();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.drain();
    });
  }

  private detach(waiter: Waiter): void {
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
  }

  private drain(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const now = this.now();
    this.admissions = this.admissions.filter((entry) => entry.admittedAt + WINDOW_MS > now);
    let used = this.admissions.reduce((sum, entry) => sum + entry.tokens, 0);
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0]!;
      const tokens = Math.max(1, Math.ceil(waiter.estimatedTokens * this.correction));
      if (tokens > this.tokensPerMinute) {
        this.waiters.shift();
        this.detach(waiter);
        waiter.reject(new Error(MODEL_REQUEST_LIMIT_ERROR));
        continue;
      }
      if (used + tokens > this.tokensPerMinute) break;
      this.waiters.shift();
      this.detach(waiter);
      const admission: Admission = { admittedAt: now, tokens };
      this.admissions.push(admission);
      used += tokens;
      let settled = false;
      waiter.resolve({
        waitedMs: Math.max(0, now - waiter.queuedAt),
        complete: (actualInputTokens) => {
          if (settled) return;
          settled = true;
          if (
            actualInputTokens !== undefined &&
            Number.isFinite(actualInputTokens) &&
            actualInputTokens > 0
          ) {
            admission.tokens = Math.ceil(actualInputTokens);
            // Smooth noisy reports, while bounding how far one estimate can move.
            const ratio = Math.min(4, Math.max(0.25, actualInputTokens / waiter.estimatedTokens));
            this.correction = Math.min(4, Math.max(0.25, this.correction * 0.75 + ratio * 0.25));
          }
          this.drain();
        },
        release: () => {
          if (settled) return;
          settled = true;
          const index = this.admissions.indexOf(admission);
          if (index >= 0) this.admissions.splice(index, 1);
          this.drain();
        },
      });
    }
    if (this.waiters.length > 0 && this.admissions.length > 0) {
      const earliest = this.admissions[0]!;
      this.timer = setTimeout(
        () => this.drain(),
        Math.max(1, earliest.admittedAt + WINDOW_MS - now),
      );
    }
  }
}
