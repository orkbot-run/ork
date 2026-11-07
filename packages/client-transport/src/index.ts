// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { cancelResponseBody, readBoundedJsonResponse, withAbort } from "@orkbot/core";
import type { ClientContext, ClientOptions } from "@orpc/client";
import { StandardRPCLink } from "@orpc/client/standard";
import type { StandardLazyResponse } from "@orpc/standard-server";
import { rpcHttpError } from "./codec.js";
import { RPC_MAX_BYTES, readRpcEnvelopes } from "./events.js";
import { requestSignal } from "./signal.js";

export type { RpcJsonEnvelope } from "./codec.js";
export { decodeRpcJson, encodeRpcJson, rpcHttpError } from "./codec.js";
export type { RpcEventOptions } from "./events.js";
export { RPC_IDLE_TIMEOUT_MS, RPC_MAX_BYTES, readRpcEvents } from "./events.js";
export { requestSignal } from "./signal.js";

export type RpcTransportCall<T extends ClientContext> = ClientOptions<T> & {
  path: readonly string[];
  input: unknown;
};
export interface RpcTransportOptions<T extends ClientContext> {
  url: string | ((call: RpcTransportCall<T>) => string);
  fetch: (input: string, init: RequestInit, call: RpcTransportCall<T>) => Promise<Response>;
  headers?: (call: RpcTransportCall<T>) => HeadersInit | Promise<HeadersInit>;
  onResponse?: (response: Response, call: RpcTransportCall<T>) => void;
  maxResponseBytes?: number;
  maxFrameBytes?: number;
  idleTimeoutMs?: number | null;
  timeoutMs?: number | null;
}

/** Shared wire transport. Authentication and response policy belong to each native surface. */
export function createRpcLink<T extends ClientContext = Record<never, never>>(
  config: RpcTransportOptions<T>,
) {
  const makeLink = (
    url: string,
    headers: HeadersInit | Promise<HeadersInit>,
    finalizers: (() => void)[],
  ) =>
    new StandardRPCLink<T>(
      {
        async call(request, options, path, input): Promise<StandardLazyResponse> {
          const call = { ...options, path, input };
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (value !== undefined)
              headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          headers.set("content-type", "application/json");
          headers.set("accept", "application/json, text/event-stream");
          const form = request.body instanceof FormData;
          if (form) headers.delete("content-type");
          if (
            request.body &&
            typeof request.body === "object" &&
            Symbol.asyncIterator in request.body
          )
            throw new TypeError("RPC request streams are not supported by this transport.");
          options.signal?.throwIfAborted();
          const pending = config
            .fetch(
              request.url.href,
              {
                method: request.method,
                headers,
                body: form ? (request.body as FormData) : JSON.stringify(request.body),
                signal: options.signal,
                redirect: "manual",
              },
              call,
            )
            .then((response) => {
              if (options.signal?.aborted) cancelResponseBody(response);
              return response;
            });
          const response = await withAbort(pending, options.signal!, "Request canceled");
          finalizers.push(() => cancelResponseBody(response));
          try {
            config.onResponse?.(response, call);
          } catch (error) {
            cancelResponseBody(response);
            throw error;
          }
          let body: ReturnType<StandardLazyResponse["body"]> | undefined;
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: () =>
              (body ??= (async () => {
                if (
                  response.ok &&
                  response.headers.get("content-type")?.startsWith("text/event-stream")
                ) {
                  const stream = new AbortController();
                  const abort = () => stream.abort(options.signal?.reason);
                  options.signal?.addEventListener("abort", abort, { once: true });
                  if (options.signal?.aborted) abort();
                  finalizers.push(() => {
                    options.signal?.removeEventListener("abort", abort);
                    stream.abort(new Error("Subscription closed"));
                  });
                  // StandardRPCLink owns the envelope decoder; the reader only frames the wire data.
                  return readRpcEnvelopes(response, {
                    signal: stream.signal,
                    maxFrameBytes: config.maxFrameBytes,
                    idleTimeoutMs: config.idleTimeoutMs ?? null,
                    throwOnAbort: true,
                  });
                }
                let parsed: unknown;
                try {
                  parsed = await readBoundedJsonResponse(
                    response,
                    config.maxResponseBytes ?? RPC_MAX_BYTES,
                    options.signal,
                  );
                } catch (error) {
                  if (options.signal?.aborted) throw options.signal.reason;
                  if (response.ok || !(error instanceof SyntaxError)) throw error;
                }
                if (!response.ok) throw rpcHttpError(response, parsed);
                return parsed;
              })()),
          };
        },
      },
      {
        url,
        headers: async () => Object.fromEntries(new Headers(await headers)),
      },
    );
  return {
    async call(path: readonly string[], input: unknown, options: ClientOptions<T>) {
      const deadline = requestSignal(options.signal, config.timeoutMs);
      const finalizers: (() => void)[] = [];
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        deadline.signal.removeEventListener("abort", close);
        deadline.dispose();
        for (const finalize of finalizers) finalize();
      };
      deadline.signal.addEventListener("abort", close, { once: true });
      let streaming = false;
      try {
        const procedure = [...path];
        const snapshot = { ...options, context: { ...options.context }, signal: deadline.signal };
        const call = { ...snapshot, path: procedure, input };
        const url = typeof config.url === "string" ? config.url : config.url(call);
        const supplied = config.headers?.(call) ?? {};
        const headers =
          supplied instanceof Promise
            ? supplied.then((value) => new Headers(value))
            : new Headers(supplied);
        const output = await withAbort(
          makeLink(url, headers, finalizers).call(procedure, input, snapshot),
          deadline.signal,
        );
        if (output && typeof output === "object" && Symbol.asyncIterator in output) {
          streaming = true;
          const iterator = (output as AsyncIterable<unknown>)[Symbol.asyncIterator]();
          return {
            async next() {
              try {
                deadline.signal.throwIfAborted();
                const next = await iterator.next();
                if (next.done) close();
                return next;
              } catch (error) {
                close();
                throw error;
              }
            },
            async return(value?: unknown) {
              close();
              return iterator.return ? iterator.return(value) : { done: true as const, value };
            },
            async throw(error?: unknown) {
              close();
              if (iterator.throw) return iterator.throw(error);
              throw error;
            },
            [Symbol.asyncIterator]() {
              return this;
            },
          };
        }
        return output;
      } catch (error) {
        if (deadline.signal.aborted) throw deadline.signal.reason;
        // StandardRPCLink wraps body failures. Keep HTTP errors recognizable to existing callers.
        if (
          error instanceof Error &&
          error.cause &&
          typeof error.cause === "object" &&
          "status" in error.cause
        )
          throw error.cause;
        throw error;
      } finally {
        if (!streaming) close();
      }
    },
  };
}
