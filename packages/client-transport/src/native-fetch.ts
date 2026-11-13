// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { withAbort } from "@orkbot/core/async";
import { throwIfAborted } from "./signal.js";

export interface NativeHttpBridge {
  open(session: string, revision: number, id: string, input: string): Promise<void>;
  start(session: string, revision: number, id: string): Promise<void>;
  write(session: string, revision: number, id: string, bytes: string): Promise<boolean>;
  finish(session: string, revision: number, id: string): Promise<void>;
  head(
    session: string,
    revision: number,
    id: string,
  ): Promise<{
    status: number;
    headers: { name: string; value: string }[];
  }>;
  read(session: string, revision: number, id: string): Promise<string | null>;
  cancel(session: string, revision: number, id: string): Promise<void>;
}

export interface NativeHttpContext {
  session: string;
  revision: number;
  origin: string;
  current(): boolean;
  relayTicket?(signal?: AbortSignal): Promise<string>;
}

const CHUNK = 64 * 1024;
const refused = () => new Error("Native connection changed");
const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
};
const decode = (encoded: string) => {
  if (encoded.length > 88 * 1024) throw new Error("Native response chunk exceeds its limit");
  const value = atob(encoded);
  if (value.length > CHUNK) throw new Error("Native response chunk exceeds its limit");
  return Uint8Array.from(value, (byte) => byte.charCodeAt(0));
};

/** Uploads cross the native bridge in bounded chunks; a rejected body is never retried. */
async function* bodyChunks(body: BodyInit, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  if (typeof body === "string" || body instanceof URLSearchParams) {
    const text = body.toString();
    const encoder = new TextEncoder();
    for (let offset = 0; offset < text.length; ) {
      let end = Math.min(offset + 16 * 1024, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      yield encoder.encode(text.slice(offset, end));
      offset = end;
    }
  } else if (body instanceof Blob) {
    for (let offset = 0; offset < body.size; offset += CHUNK)
      yield new Uint8Array(
        await withAbort(new Response(body.slice(offset, offset + CHUNK)).arrayBuffer(), signal),
      );
  } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes =
      body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    for (let offset = 0; offset < bytes.length; offset += CHUNK)
      yield bytes.subarray(offset, offset + CHUNK);
  } else if (body instanceof ReadableStream) {
    const reader = body.getReader();
    let complete = false;
    try {
      for (;;) {
        const next = await withAbort(reader.read(), signal);
        if (next.done) {
          complete = true;
          return;
        }
        if (!(next.value instanceof Uint8Array)) throw new TypeError("Expected a byte stream");
        for (let offset = 0; offset < next.value.length; offset += CHUNK)
          yield next.value.subarray(offset, offset + CHUNK);
      }
    } finally {
      if (!complete) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } else throw new TypeError("This request body cannot be streamed by the native transport");
}

/** React Native's global Response constructor does not accept a ReadableStream body. */
class NativeResponse implements Response {
  readonly type = "basic" as const;
  readonly redirected = false;
  readonly statusText = "";
  readonly headers: Headers;
  readonly ok: boolean;
  readonly [Symbol.toStringTag] = "Response";
  private consumed = false;
  private tracking = { detached: false };
  private stream: ReadableStream<Uint8Array<ArrayBuffer>> | null;

  constructor(
    readonly status: number,
    headers: HeadersInit,
    readonly url: string,
    stream: ReadableStream<Uint8Array<ArrayBuffer>> | null,
  ) {
    this.headers = new Headers(headers);
    this.ok = status >= 200 && status < 300;
    this.stream = this.track(stream);
  }
  private track(source: ReadableStream<Uint8Array<ArrayBuffer>> | null) {
    if (!source) return null;
    const tracking = this.tracking;
    let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
    return new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        pull: async (controller) => {
          if (!tracking.detached) this.consumed = true;
          reader ??= source.getReader();
          try {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              reader.releaseLock();
            } else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
            reader.releaseLock();
          }
        },
        cancel: (reason) => {
          if (!tracking.detached) this.consumed = true;
          if (reader) void reader.cancel(reason).catch(() => undefined);
          else void source.cancel(reason).catch(() => undefined);
        },
      },
      { highWaterMark: 0 },
    );
  }
  get body() {
    return this.stream;
  }
  get bodyUsed() {
    return this.consumed;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.consumed || this.stream?.locked) throw new TypeError("Response body already used");
    this.consumed = true;
    if (!this.stream) return new ArrayBuffer(0);
    const reader = this.stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
        length += next.value.length;
      }
    } finally {
      reader.releaseLock();
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result.buffer;
  }
  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await this.arrayBuffer());
  }
  async text(): Promise<string> {
    return new TextDecoder().decode(await this.arrayBuffer());
  }
  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
  async blob(): Promise<Blob> {
    return new Blob([await this.arrayBuffer()], { type: this.headers.get("content-type") ?? "" });
  }
  async formData(): Promise<never> {
    throw new TypeError("Multipart response parsing is unavailable on this transport");
  }
  clone(): Response {
    if (this.consumed || this.stream?.locked) throw new TypeError("Response body already used");
    const pair = this.stream?.tee();
    this.tracking.detached = true;
    this.tracking = { detached: false };
    this.stream = this.track(pair?.[0] ?? null);
    return new NativeResponse(this.status, this.headers, this.url, pair?.[1] ?? null);
  }
}

/** Every call keeps one immutable native selection; headers, bytes and cancellation share it. */
export function createNativeFetch(
  bridge: NativeHttpBridge,
  context: NativeHttpContext,
  newId: () => string,
): typeof fetch {
  return async (input, init) => {
    const request = typeof input === "string" || input instanceof URL ? null : input;
    const url = new URL(request?.url ?? String(input));
    if (url.origin !== context.origin || url.username || url.password || url.hash) throw refused();
    const signal = init?.signal ?? request?.signal ?? undefined;
    const check = () => {
      throwIfAborted(signal);
      if (!context.current()) throw refused();
    };
    check();
    const id = newId();
    const args = [context.session, context.revision, id] as const;
    let closed = false;
    const lifetime = new AbortController();
    let controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      lifetime.abort(signal?.reason ?? refused());
      signal?.removeEventListener("abort", abort);
      void bridge.cancel(...args).catch(() => undefined);
    };
    const abort = () => {
      controller?.error(signal?.reason ?? refused());
      close();
    };
    const checked = async <T>(pending: Promise<T>): Promise<T> => {
      const result = signal ? await withAbort(pending, signal) : await pending;
      check();
      if (closed) throw refused();
      return result;
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      check();
      const headers = new Headers(init?.headers ?? request?.headers);
      const suppliedOrigin = headers.get("origin");
      if (suppliedOrigin !== null && suppliedOrigin !== "orkbot://")
        throw new TypeError("Invalid native request origin");
      headers.delete("origin");
      headers.delete("host");
      headers.delete("content-length");
      const body = init?.body ?? request?.body;
      if (body instanceof FormData)
        throw new TypeError("Multipart bodies require a streaming encoder");
      if (body instanceof Blob && body.type && !headers.has("content-type"))
        headers.set("content-type", body.type);
      if (body instanceof URLSearchParams && !headers.has("content-type"))
        headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      const opened = bridge.open(
        ...args,
        JSON.stringify({
          method: init?.method ?? request?.method ?? "GET",
          path: `${url.pathname}${url.search}`,
          headers: Array.from(headers, ([name, value]) => ({ name, value })),
          hasBody: body != null,
          ...(context.relayTicket
            ? { relayTicket: await checked(context.relayTicket(signal ?? undefined)) }
            : {}),
        }),
      );
      void opened
        .finally(() => {
          if (closed) void bridge.cancel(...args).catch(() => undefined);
        })
        .catch(() => undefined);
      await checked(opened);
      await checked(bridge.start(...args));
      const upload = (async () => {
        if (body != null) {
          for await (const chunk of bodyChunks(body, lifetime.signal)) {
            check();
            if (!(await checked(bridge.write(...args, base64(chunk))))) return;
          }
          await checked(bridge.finish(...args));
        }
      })();
      const failedUpload = upload.then(() => new Promise<never>(() => {}));
      void failedUpload.catch(() => undefined);
      const head = await checked(Promise.race([bridge.head(...args), failedUpload]));
      void upload.catch((error) => {
        if (!closed) {
          controller?.error(error);
          close();
        }
      });
      const stream = new ReadableStream<Uint8Array<ArrayBuffer>>(
        {
          start(value) {
            controller = value;
          },
          async pull(value) {
            try {
              check();
              const chunk = await checked(bridge.read(...args));
              if (chunk === null) {
                value.close();
                close();
              } else value.enqueue(decode(chunk));
            } catch (error) {
              value.error(error);
              close();
            }
          },
          cancel() {
            close();
          },
        },
        { highWaterMark: 0 },
      );
      const empty =
        (init?.method ?? request?.method ?? "GET").toUpperCase() === "HEAD" ||
        [204, 205, 304].includes(head.status);
      if (empty) {
        close();
        void stream.cancel().catch(() => undefined);
      }
      return new NativeResponse(
        head.status,
        head.headers.map(({ name, value }) => [name, value]),
        url.href,
        empty ? null : stream,
      );
    } catch (error) {
      close();
      throw error;
    }
  };
}
