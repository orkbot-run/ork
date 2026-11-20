// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Ork adds model upstream response timing. See LICENSE.md for inherited Apache material.

import { randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { getLogger } from "@orkbot/logging";
import { openRouterZdrFetch } from "./openrouter-zdr.js";
import { codexComputeResidency } from "./pi-oauth.js";
import {
  modelStreamIdleTimeoutMs,
  modelStreamMaxRetries,
  modelStreamTimeoutMs,
  operatorMaxTokens,
  resolveCompletionMaxTokens,
} from "./pi-runtime-limits.js";
import { fetchPairedWithDispatcher } from "./undici-fetch.js";

/** Stable OpenCode affinity id for a bot conversation (and optional nested agent). */
export function conversationSessionId(threadId: string, botId: string, agentId?: string): string {
  return agentId ? `${threadId}:${botId}:${agentId}` : `${threadId}:${botId}`;
}

export function isOpenCodeProvider(provider: string): boolean {
  return provider === "opencode" || provider === "opencode-go";
}

export function isCodexModel(model: Pick<Model<Api>, "api" | "provider">): boolean {
  return model.provider === "openai-codex" || model.api === "openai-codex-responses";
}

/** Abort reason recorded when a model stream goes silent past the idle bound. */
export const MODEL_STREAM_IDLE_TIMEOUT_MESSAGE = "Model stream idle timeout";

export interface StreamIdleWatchdog {
  signal: AbortSignal;
  /** Re-arms the idle bound; invoke on response headers and each delivered event. */
  ping(): void;
  /** Wraps the provider stream so every delivered event re-arms the idle bound. */
  wrap(
    stream: AssistantMessageEventStream,
    observe?: (event: AssistantMessageEvent) => void,
  ): AssistantMessageEventStream;
  dispose(): void;
}

/**
 * `timeoutMs` bounds only time-to-headers; after that pi reads the body until it
 * ends or the signal aborts, so silence can stall a run. The watchdog arms only on
 * a 2xx response, keeping time-to-headers and retry backoff outside the idle bound.
 * pi reports any abort as "Request was aborted", so the wrapper relabels it as an
 * idle timeout when the watchdog fired.
 */
export function modelStreamIdleWatchdog(
  upstream: AbortSignal | undefined,
  idleTimeoutMs: number = modelStreamIdleTimeoutMs(),
): StreamIdleWatchdog {
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onUpstreamAbort = () => controller.abort(upstream?.reason);
  if (upstream?.aborted) controller.abort(upstream.reason);
  else upstream?.addEventListener("abort", onUpstreamAbort, { once: true });

  const arm = () => {
    if (disposed || controller.signal.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort(new Error(MODEL_STREAM_IDLE_TIMEOUT_MESSAGE));
    }, idleTimeoutMs);
    timer.unref?.();
  };

  const dispose = () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    upstream?.removeEventListener("abort", onUpstreamAbort);
  };

  // Nothing arms the timer before a successful response's headers land: the
  // pre-headers window is bounded per attempt by timeoutMs and retry backoff
  // by maxRetryDelayMs, so idle budget must not burn there and a retry always
  // starts from a fresh full budget.
  const ping = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    arm();
  };

  const describeTimeout = (message: AssistantMessage): AssistantMessage =>
    timedOut && message.stopReason === "aborted"
      ? {
          ...message,
          stopReason: "error",
          errorMessage: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE,
        }
      : message;

  const rewrite = (event: AssistantMessageEvent): AssistantMessageEvent => {
    if (event.type !== "error") return event;
    const error = describeTimeout(event.error);
    return error === event.error ? event : { type: "error", reason: "error", error };
  };

  return {
    signal: controller.signal,
    ping,
    dispose,
    wrap(inner, observe) {
      class Watched extends AssistantMessageEventStream {
        override async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
          try {
            for await (const event of inner) {
              ping();
              observe?.(event);
              yield rewrite(event);
            }
          } finally {
            dispose();
          }
        }
        override result(): Promise<AssistantMessage> {
          return inner.result().then(describeTimeout).finally(dispose);
        }
      }
      return new Watched();
    },
  };
}

/** Keep network details useful without persisting arbitrary cause text from the transport. */
function describeTerminatedResponse(error: unknown): unknown {
  if (!(error instanceof TypeError) || error.message !== "terminated") return error;
  const cause: unknown = error.cause;
  if (!(cause instanceof Error) || !("code" in cause)) return error;
  if (cause.code === "UND_ERR_SOCKET" && cause.message === "other side closed") {
    return new TypeError("terminated (other side closed)", { cause });
  }
  if (cause.code === "ECONNRESET") {
    return new TypeError("terminated (connection reset)", { cause });
  }
  return error;
}

/** Bound silent non-2xx bodies without aborting the watchdog and skipping retry backoff. */
function modelResponseBody(
  response: Response,
  idleTimeoutMs: number,
  reportDisconnect: boolean,
): Response {
  if (response.body == null || (response.ok && !reportDisconnect)) return response;
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const read = reader.read().then(
        (chunk) => ({ kind: "chunk" as const, chunk }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const outcome = response.ok
        ? await read
        : await Promise.race([
            read,
            new Promise<{ kind: "timeout" }>((resolve) => {
              timer = setTimeout(() => resolve({ kind: "timeout" }), idleTimeoutMs);
              timer.unref?.();
            }),
          ]);
      clear();
      if (outcome.kind === "timeout") {
        const error = new Error(MODEL_STREAM_IDLE_TIMEOUT_MESSAGE);
        void reader.cancel(error).catch(() => undefined);
        controller.error(error);
        return;
      }
      if (outcome.kind === "error") {
        controller.error(
          reportDisconnect ? describeTerminatedResponse(outcome.error) : outcome.error,
        );
        return;
      }
      if (outcome.chunk.done) controller.close();
      else controller.enqueue(outcome.chunk.value);
    },
    cancel(reason) {
      clear();
      return reader.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  if (!response.ok) {
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function modelRequestFetch(
  fetchImpl: ModelsSimpleStreamOptions["fetch"],
  idleTimeoutMs: number,
  zeroDataRetention = false,
): NonNullable<ModelsSimpleStreamOptions["fetch"]> {
  return async (input, init) => {
    // Local and compatible providers attach a package undici dispatcher after this wrapper is
    // installed. Pair that dispatcher without replacing other providers' fetch.
    const usesDispatcher = init !== undefined && "dispatcher" in init;
    const transport = usesDispatcher
      ? fetchPairedWithDispatcher(fetchImpl)
      : (fetchImpl ?? globalThis.fetch);
    const response = await (zeroDataRetention ? openRouterZdrFetch(transport) : transport)(
      input,
      init,
    );
    return modelResponseBody(response, idleTimeoutMs, usesDispatcher);
  };
}

// These Pi adapters reject fetch overrides other than globalThis.fetch.
const APIS_WITHOUT_CUSTOM_FETCH = new Set<Api>(["google-generative-ai", "google-vertex"]);

export function reliableModelStream(
  models: Models,
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions | undefined,
  configuredMaxTokens: number | undefined,
  accessToken?: string | (() => string | undefined),
  runStream?: (options: ModelsSimpleStreamOptions) => AssistantMessageEventStream,
  cacheRetention?: ModelsSimpleStreamOptions["cacheRetention"],
): AssistantMessageEventStream {
  const watchdog = modelStreamIdleWatchdog(options?.signal);
  const started = performance.now();
  let headersAt: number | undefined;
  let firstTextRecorded = false;
  try {
    const preparedOptions = reliableStreamOptions(
      model,
      {
        ...options,
        signal: watchdog.signal,
        fetch: APIS_WITHOUT_CUSTOM_FETCH.has(model.api)
          ? options?.fetch
          : modelRequestFetch(
              options?.fetch,
              modelStreamIdleTimeoutMs(),
              (model as Model<Api> & { zeroDataRetention?: boolean }).zeroDataRetention === true,
            ),
        // Only a 2xx arms the shared watchdog. Error bodies are bounded by
        // the fetch wrapper where supported; caller hooks still see every status.
        onResponse: (response, requestModel) => {
          if (response.status >= 200 && response.status < 300) {
            watchdog.ping();
            headersAt = performance.now();
            getLogger().info("model.response_headers", {
              "model.headers_ms": Math.round(headersAt - started),
            });
          }
          return options?.onResponse?.(response, requestModel);
        },
      },
      configuredMaxTokens,
      accessToken,
      cacheRetention,
    );
    const stream = runStream
      ? runStream(preparedOptions)
      : models.streamSimple(model, context, preparedOptions);
    return watchdog.wrap(stream, (event) => {
      if (firstTextRecorded || event.type !== "text_delta" || !event.delta.trim()) return;
      firstTextRecorded = true;
      const at = performance.now();
      getLogger().info("model.first_text", {
        "model.first_text_ms": Math.round(at - started),
        ...(headersAt === undefined
          ? {}
          : { "model.headers_to_first_text_ms": Math.round(at - headersAt) }),
      });
    });
  } catch (error) {
    watchdog.dispose();
    throw error;
  }
}

const CODEX_RESIDENCY_HEADER = "x-openai-internal-codex-residency";

/** Header names are case-insensitive: any caller-set casing counts as explicit. */
function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === name);
}

export function reliableStreamOptions(
  model: Pick<Model<Api>, "api" | "provider" | "maxTokens" | "reasoning"> &
    Partial<Pick<Model<Api>, "contextWindow">>,
  options?: ModelsSimpleStreamOptions,
  configuredMaxTokens?: number,
  accessToken?: string | (() => string | undefined),
  cacheRetention?: ModelsSimpleStreamOptions["cacheRetention"],
): ModelsSimpleStreamOptions {
  let next: ModelsSimpleStreamOptions = {
    ...options,
    ...(cacheRetention ? { cacheRetention } : {}),
    timeoutMs: options?.timeoutMs ?? modelStreamTimeoutMs(),
    maxRetries: options?.maxRetries ?? modelStreamMaxRetries(),
    maxTokens: resolveCompletionMaxTokens(
      model.maxTokens,
      configuredMaxTokens,
      options?.maxTokens,
      model.reasoning,
      model.contextWindow,
      operatorMaxTokens(model),
    ),
  };

  if (isCodexModel(model)) {
    // Pi cannot fall back after a WebSocket has emitted its start event. Long tool
    // runs then surface abnormal close 1006 as a terminal model error. SSE has
    // bounded network retries and no long-lived connection between tool turns.
    next = { ...next, transport: "sse" };
    // Compute residency routes the Codex backend to the right region. An OAuth
    // refresh can swap the credential after these options are built, so the claim
    // is read in transformHeaders at request time. Explicit headers win.
    const callerTransform = next.transformHeaders;
    next = {
      ...next,
      transformHeaders: (headers) => {
        const residency = codexComputeResidency(
          typeof accessToken === "function" ? accessToken() : accessToken,
        );
        const merged =
          residency && !hasHeader(headers, CODEX_RESIDENCY_HEADER)
            ? { ...headers, [CODEX_RESIDENCY_HEADER]: residency }
            : headers;
        return callerTransform ? callerTransform(merged) : merged;
      },
    };
  }

  // OpenCode Go/Zen require a sticky x-opencode-session header (affinity + some
  // models 400 without it). Pi 0.85.1 does not attach that header on its own.
  if (isOpenCodeProvider(model.provider)) {
    const sessionId = next.sessionId?.trim() || randomUUID();
    next = {
      ...next,
      sessionId,
      headers: {
        "x-opencode-session": sessionId,
        "x-opencode-client": "orkbot",
        ...next.headers,
      },
    };
  }

  return next;
}
