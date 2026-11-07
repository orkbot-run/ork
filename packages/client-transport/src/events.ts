// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited mobile bounded-reader behavior is preserved. Shared oRPC decoding is an Ork addition.

import { createORPCErrorFromJson, isORPCErrorJson } from "@orpc/client";
import { decodeEventMessage, ErrorEvent, getEventMeta, withEventMeta } from "@orpc/standard-server";
import { decodeRpcJson } from "./codec.js";

export const RPC_MAX_BYTES = 16 * 1024 * 1024;
export const RPC_IDLE_TIMEOUT_MS = 45_000;

export interface RpcEventOptions {
  signal?: AbortSignal;
  maxFrameBytes?: number;
  idleTimeoutMs?: number | null;
  ignoreMalformed?: boolean;
  throwOnAbort?: boolean;
}

/** Bound bytes before decoding, including delimiters, without requiring TextDecoderStream. */
export async function* readRpcEnvelopes(
  response: Response,
  options: RpcEventOptions = {},
): AsyncGenerator<unknown> {
  const limit = options.maxFrameBytes ?? RPC_MAX_BYTES;
  const idle = options.idleTimeoutMs === undefined ? RPC_IDLE_TIMEOUT_MS : options.idleTimeoutMs;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new RangeError("Frame limit must be a positive integer.");
  if (idle != null && (!Number.isFinite(idle) || idle < 0))
    throw new RangeError("Idle timeout must be nonnegative.");
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let scratch = new Uint8Array(Math.min(1024, limit));
  let used = 0;
  let lineBytes = 0;
  let pendingCr = false;
  let discardLf = false;
  let finished = false;
  function append(byte: number) {
    if (used >= limit) throw new RangeError(`Thread SSE frame exceeds ${limit} bytes`);
    if (used === scratch.length) {
      const grown = new Uint8Array(Math.min(limit, Math.max(1, scratch.length * 2)));
      grown.set(scratch);
      scratch = grown;
    }
    scratch[used++] = byte;
  }
  function* frames(chunk: Uint8Array): Generator<Uint8Array> {
    for (const byte of chunk) {
      if (discardLf) {
        discardLf = false;
        if (byte === 10) continue;
      }
      let crLineEnding = false;
      if (pendingCr && byte !== 10) {
        pendingCr = false;
        if (lineBytes === 0) {
          yield scratch.subarray(0, used);
          used = 0;
        }
        lineBytes = 0;
        crLineEnding = true;
      }
      append(byte);
      if (byte === 13) {
        if (crLineEnding) {
          yield scratch.subarray(0, used);
          used = 0;
          discardLf = true;
        } else pendingCr = true;
      } else if (byte === 10) {
        pendingCr = false;
        if (lineBytes === 0) {
          yield scratch.subarray(0, used);
          used = 0;
        }
        lineBytes = 0;
      } else lineBytes++;
    }
  }
  try {
    while (!options.signal?.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<"idle" | "aborted">((resolve) => {
          if (idle != null) timer = setTimeout(() => resolve("idle"), idle);
          onAbort = () => resolve("aborted");
          options.signal?.addEventListener("abort", onAbort, { once: true });
          if (options.signal?.aborted) onAbort();
        }),
      ]).finally(() => {
        clearTimeout(timer);
        if (onAbort) options.signal?.removeEventListener("abort", onAbort);
      });
      if (next === "idle") return;
      if (next === "aborted") {
        if (options.throwOnAbort) throw options.signal?.reason ?? new Error("Request canceled");
        return;
      }
      const completed: Uint8Array[] = [];
      if (next.done) {
        finished = true;
        // A final CR is itself a line ending; a following LF is optional.
        if (pendingCr && lineBytes === 0) completed.push(scratch.subarray(0, used));
        else return;
      }
      for (const bytes of next.done ? completed : frames(next.value)) {
        if (options.signal?.aborted) {
          if (options.throwOnAbort) throw options.signal.reason ?? new Error("Request canceled");
          return;
        }
        const frame = decodeEventMessage(decoder.decode(bytes));
        if (frame.event === "done" || frame.event === "close") return;
        if (frame.data === undefined || frame.data === "" || frame.data === "[DONE]") continue;
        if (frame.event && frame.event !== "message" && frame.event !== "error") continue;
        let envelope: unknown;
        try {
          envelope = JSON.parse(frame.data);
        } catch (error) {
          if (options.ignoreMalformed) continue;
          throw error;
        }
        if (frame.event === "error") {
          const decoded = decodeRpcJson(envelope);
          if (isORPCErrorJson(decoded)) throw createORPCErrorFromJson(decoded);
          throw new ErrorEvent({ data: decoded });
        }
        if (envelope !== null && typeof envelope === "object")
          envelope = withEventMeta(envelope, frame);
        yield envelope;
      }
      if (next.done) return;
    }
    if (options.throwOnAbort && options.signal?.aborted)
      throw options.signal.reason ?? new Error("Request canceled");
  } finally {
    if (!finished) {
      try {
        void Promise.resolve(reader.cancel()).catch(() => undefined);
      } catch {
        /* Cancellation must not delay releasing an abandoned reader. */
      }
    }
    reader.releaseLock();
  }
}

/** Decoded values for native facades that retain their own request and recovery policy. */
export async function* readRpcEvents(
  response: Response,
  options: RpcEventOptions = {},
): AsyncGenerator<unknown> {
  for await (const envelope of readRpcEnvelopes(response, options)) {
    let decoded: unknown;
    try {
      decoded = decodeRpcJson(envelope);
    } catch (error) {
      if (options.ignoreMalformed) continue;
      throw error;
    }
    const meta = getEventMeta(envelope);
    if (meta && decoded !== null && typeof decoded === "object")
      decoded = withEventMeta(decoded, meta);
    yield decoded;
  }
}
