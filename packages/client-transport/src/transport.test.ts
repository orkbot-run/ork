// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { getEventMeta, ORPCError } from "@orpc/client";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { withEventMeta } from "@orpc/standard-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRpcLink,
  decodeRpcJson,
  encodeRpcJson,
  readRpcEvents,
  requestSignal,
  rpcHttpError,
} from "./index.js";

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const encoder = new TextEncoder();
function response(chunks: string[], cancel = vi.fn()) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      },
      cancel,
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
async function collect(events: AsyncIterable<unknown>) {
  const values: unknown[] = [];
  for await (const event of events) values.push(event);
  return values;
}

describe("shared RPC wire transport", () => {
  it("supports unary and streamed requests without a native signal abort guard", async () => {
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "throwIfAborted", { value: undefined });
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit, call: { path: readonly string[] }) =>
        call.path[0] === "events"
          ? response(['data: {"json":1}\n\ndata: {"json":2}\n\n'])
          : Response.json({ json: { ok: true } }),
    );
    const link = createRpcLink({ url: "https://server.example.test/rpc", fetch });
    const options = { context: {}, signal: controller.signal };
    await expect(link.call(["read"], {}, options)).resolves.toEqual({ ok: true });
    const events = (await link.call(["events"], {}, options)) as AsyncGenerator;
    expect((await events.next()).value).toBe(1);
    const reason = new Error("Retired request");
    controller.abort(reason);
    await expect(events.next()).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["before", "during"])(
    "rejects cancellation %s fetching when the signal has no abort reason",
    async (phase) => {
      const controller = new AbortController();
      Object.defineProperties(controller.signal, {
        throwIfAborted: { value: undefined },
        reason: { value: undefined },
      });
      const started = deferred<void>();
      const fetch = vi.fn(() => {
        started.resolve();
        return new Promise<Response>(() => {});
      });
      const link = createRpcLink({ url: "https://server.example.test/rpc", fetch });
      if (phase === "before") controller.abort();
      const pending = link.call(["read"], {}, { context: {}, signal: controller.signal });
      if (phase === "during") {
        await Promise.race([started.promise, pending.catch(() => undefined)]);
        controller.abort();
      }
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      if (phase === "before") expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not cancel a fully consumed unary response", async () => {
    const body = Response.json({ json: { ok: true } });
    const cancel = vi.spyOn(body.body!, "cancel");
    const link = createRpcLink({ url: "https://server.example.test/rpc", fetch: async () => body });
    await expect(link.call(["read"], {}, { context: {} })).resolves.toEqual({ ok: true });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("interoperates with the real oRPC handler for metadata, errors and streaming", async () => {
    const date = new Date("2026-11-01T00:00:00.000Z");
    const handler = new RPCHandler({
      read: os.handler(() => ({ date, count: 123n })),
      fail: os.handler(() => {
        throw new ORPCError("CONFLICT", { message: "Changed", data: { revision: 2 } });
      }),
      events: os.handler(async function* () {
        yield withEventMeta({ date, type: "first" }, { id: "event-1", retry: 100 });
        yield { type: "second" };
      }),
    });
    const observed = vi.fn();
    const link = createRpcLink({
      url: "https://server.example.test/rpc",
      fetch: async (url, init) => {
        const result = await handler.handle(new Request(url, init), {
          prefix: "/rpc",
          context: {},
        });
        if (!result.response) throw new Error("Fixture route missing");
        return result.response;
      },
      onResponse: observed,
    });
    expect(await link.call(["read"], {}, { context: {} })).toEqual({ date, count: 123n });
    const failure = await link.call(["fail"], {}, { context: {} }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ORPCError);
    expect(failure).toMatchObject({
      status: 409,
      code: "CONFLICT",
      message: "Changed",
      data: { revision: 2 },
    });
    const events = await collect(
      (await link.call(["events"], {}, { context: {} })) as AsyncIterable<unknown>,
    );
    expect(events).toEqual([{ date, type: "first" }, { type: "second" }]);
    expect(getEventMeta(events[0])).toMatchObject({ id: "event-1", retry: 100 });
    expect(observed).toHaveBeenCalledTimes(3);
  });

  it("observes response headers before parsing malformed, oversized or stalled bodies", async () => {
    for (const body of [
      new Response("not-json", { status: 426 }),
      new Response("12345", { status: 426 }),
      new Response(new ReadableStream(), { status: 426 }),
    ]) {
      const seen = vi.fn();
      const cancel = new AbortController();
      const link = createRpcLink({
        url: "https://server.example.test/rpc",
        fetch: async () => body,
        maxResponseBytes: 4,
        onResponse: (res) => {
          seen(res.status);
          cancel.abort(new Error("response policy"));
        },
      });
      await expect(link.call(["read"], {}, { context: {}, signal: cancel.signal })).rejects.toThrow(
        "response policy",
      );
      expect(seen).toHaveBeenCalledWith(426);
    }
  });

  it("preserves retry advice and never treats a bare proxy 404 as semantic NOT_FOUND", () => {
    const res = new Response(null, { status: 429, headers: { "retry-after": "3" } });
    expect(
      rpcHttpError(res, {
        json: { code: "RATE_LIMIT", message: "Wait", data: { scope: "request" } },
      }),
    ).toMatchObject({
      code: "RATE_LIMIT",
      status: 429,
      message: "Wait",
      data: { scope: "request" },
      retryAfterMs: 3000,
    });
    expect(rpcHttpError(new Response(null, { status: 404 }))).toMatchObject({
      code: "MALFORMED_ORPC_ERROR_RESPONSE",
      status: 404,
    });
    expect(rpcHttpError(Response.error()).status).toBe(500);
    expect(
      rpcHttpError(new Response(null), undefined, { fallbackMessage: "Missing body" }).message,
    ).toBe("Missing body");
  });

  it("enforces the unary response byte limit through the shared link", async () => {
    const cancel = vi.fn();
    const body = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"json":"too large"}'));
        },
        cancel,
      }),
    );
    const link = createRpcLink({
      url: "https://server.example.test/rpc",
      fetch: async () => body,
      maxResponseBytes: 8,
    });
    await expect(link.call(["read"], {}, { context: {} })).rejects.toMatchObject({
      cause: { name: "ResponseBodyTooLargeError" },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.body?.locked).toBe(false);
  });

  it("times out stalled fetches, body reads and header preparation without sending late mutations", async () => {
    vi.useFakeTimers();
    for (const phase of ["fetch", "body", "headers"] as const) {
      const headers = deferred<HeadersInit>();
      const cancelBody = vi.fn();
      const fetch = vi.fn(async () =>
        phase === "fetch"
          ? new Promise<Response>(() => {})
          : new Response(new ReadableStream({ cancel: cancelBody })),
      );
      const link = createRpcLink({
        url: "https://server.example.test/rpc",
        fetch,
        headers: phase === "headers" ? () => headers.promise : undefined,
        timeoutMs: 10,
      });
      const pending = link.call(["mutate"], {}, { context: {} });
      const checked = expect(pending).rejects.toMatchObject({
        name: "TimeoutError",
        message: "Request timed out",
      });
      await vi.advanceTimersByTimeAsync(10);
      await checked;
      headers.resolve({});
      await vi.advanceTimersByTimeAsync(0);
      if (phase === "headers") expect(fetch).not.toHaveBeenCalled();
      if (phase === "body") expect(cancelBody).toHaveBeenCalled();
    }
  });

  it("keeps URL and context snapshots while asynchronous headers are prepared", async () => {
    const headers = deferred<HeadersInit>();
    let url = "https://first.example.test/rpc";
    const context = { space: "first" };
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit, _call: { context: { space: string } }) =>
        Response.json({ json: true }),
    );
    const link = createRpcLink({ url: () => url, headers: () => headers.promise, fetch });
    const pending = link.call(["read"], {}, { context });
    url = "https://second.example.test/rpc";
    context.space = "second";
    headers.resolve({ authorization: "Bearer fake-first" });
    await pending;
    expect(fetch.mock.calls[0]?.[0]).toBe("https://first.example.test/rpc/read");
    expect(fetch.mock.calls[0]?.[2].context).toEqual({ space: "first" });
  });

  it("snapshots synchronous headers and procedure paths before awaiting the codec", async () => {
    const headers = new Headers({ authorization: "Bearer first-session" });
    const path = ["first"];
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ json: true }));
    const link = createRpcLink({
      url: "https://server.example.test/rpc",
      headers: () => headers,
      fetch,
    });
    const pending = link.call(path, {}, { context: {} });
    headers.set("authorization", "Bearer later-session");
    path[0] = "later";
    await pending;
    expect(fetch.mock.calls[0]?.[0]).toBe("https://server.example.test/rpc/first");
    expect(new Headers(fetch.mock.calls[0]?.[1].headers).get("authorization")).toBe(
      "Bearer first-session",
    );
  });

  it("does not fetch for an already aborted caller and preserves its exact reason", async () => {
    const reason = new Error("Retired request");
    const signal = AbortSignal.abort(reason);
    const fetch = vi.fn();
    const link = createRpcLink({ url: "https://server.example.test/rpc", fetch });
    await expect(link.call(["mutate"], {}, { context: {}, signal })).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
    expect(requestSignal(signal).signal).toBe(signal);
  });

  it("cancels a response that arrives after abort even if fetch ignored its signal", async () => {
    const fetched = deferred<Response>();
    const cancel = vi.fn();
    const controller = new AbortController();
    const started = deferred<void>();
    const link = createRpcLink({
      url: "https://server.example.test/rpc",
      fetch: () => {
        started.resolve();
        return fetched.promise;
      },
    });
    const pending = link.call(["read"], {}, { context: {}, signal: controller.signal });
    await started.promise;
    controller.abort(new Error("Gone"));
    await expect(pending).rejects.toThrow("Gone");
    fetched.resolve(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels an unconsumed subscription on abort or return before the first next", async () => {
    for (const abort of [false, true]) {
      const cancel = vi.fn();
      const controller = new AbortController();
      const link = createRpcLink({
        url: "https://server.example.test/rpc",
        fetch: async () => response([], cancel),
      });
      const events = (await link.call(
        ["events"],
        {},
        { context: {}, signal: controller.signal },
      )) as AsyncGenerator;
      if (abort) controller.abort();
      await events.return(undefined);
      expect(cancel).toHaveBeenCalledOnce();
    }
  });

  it("cancels a response when a response policy hook throws", async () => {
    const cancel = vi.fn();
    const link = createRpcLink({
      url: "https://server.example.test/rpc",
      fetch: async () => response([], cancel),
      onResponse: () => {
        throw new Error("Stop");
      },
    });
    await expect(link.call(["read"], {}, { context: {} })).rejects.toThrow("Stop");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returning a subscription interrupts its pending read without aborting the caller", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const controller = new AbortController();
    const body = response([], cancel);
    const link = createRpcLink({ url: "https://server.example.test/rpc", fetch: async () => body });
    const events = (await link.call(
      ["events"],
      {},
      { context: {}, signal: controller.signal },
    )) as AsyncGenerator;
    const pending = events.next().catch(() => undefined);
    await Promise.resolve();
    await events.return(undefined);
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.body?.locked).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });
});

describe("bounded event codec", () => {
  it("delivers a CR-only frame before the server closes or sends another byte", async () => {
    const events = readRpcEvents(response(['data: {"json":1}\r\r']));
    expect((await events.next()).value).toBe(1);
    await events.return(undefined);
  });
  it.each(["\n", "\r\n", "\r"])(
    "decodes fragmented UTF-8 and multiline events using %j",
    async (ending) => {
      const encoded = encoder.encode(
        `id: sequence${ending}data: {"json":${ending}data: {"text":"żółw"}}${ending}${ending}event: done${ending}${ending}`,
      );
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      });
      const events = await collect(readRpcEvents(new Response(stream)));
      expect(events).toEqual([{ text: "żółw" }]);
      expect(getEventMeta(events[0])?.id).toBe("sequence");
    },
  );

  it("accepts exact byte caps including delimiters and bounds each frame rather than the whole chunk", async () => {
    const frame = 'data: {"json":{"type":"event","text":"ż"}}\n\n';
    const size = encoder.encode(frame).length;
    expect(
      await collect(
        readRpcEvents(response([frame.repeat(3), "event: done\n\n"]), { maxFrameBytes: size }),
      ),
    ).toHaveLength(3);
    const cancel = vi.fn();
    await expect(
      collect(readRpcEvents(response([frame], cancel), { maxFrameBytes: size - 1 })),
    ).rejects.toBeInstanceOf(RangeError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("supports malformed mobile frames without hiding protocol error events", async () => {
    const frames = response([
      'data: not-json\n\ndata: [DONE]\n\ndata: {"json":{"type":"heartbeat"}}\n\nevent: done\n\n',
    ]);
    expect(await collect(readRpcEvents(frames, { ignoreMalformed: true }))).toEqual([
      { type: "heartbeat" },
    ]);
    const failure = response([
      'event: error\ndata: {"json":{"defined":false,"code":"FORBIDDEN","status":403,"message":"Revoked","data":{"scope":"stream"}}}\n\n',
    ]);
    await expect(collect(readRpcEvents(failure, { ignoreMalformed: true }))).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
      data: { scope: "stream" },
    });
  });

  it.each([false, true])(
    "stops buffered delivery after cancellation (throw=%j)",
    async (throwOnAbort) => {
      const controller = new AbortController();
      const events = readRpcEvents(response(['data: {"json":1}\n\ndata: {"json":2}\n\n']), {
        signal: controller.signal,
        throwOnAbort,
      });
      expect((await events.next()).value).toBe(1);
      const reason = new Error("Retired stream");
      controller.abort(reason);
      if (throwOnAbort) await expect(events.next()).rejects.toBe(reason);
      else expect((await events.next()).done).toBe(true);
    },
  );

  it("ends an idle read and releases its lock without awaiting stalled cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = response([], cancel);
    const running = collect(readRpcEvents(body, { idleTimeoutMs: 10 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(await running).toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.body?.locked).toBe(false);
  });

  it("uses the same public oRPC serialization for unary and streamed values", () => {
    const input = { nested: new Map([["first", 2n]]), missing: undefined, date: new Date(0) };
    expect(decodeRpcJson(encodeRpcJson(input))).toEqual(input);
  });
});
