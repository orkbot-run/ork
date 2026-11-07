// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { abortableDelay, withAbort } from "@orkbot/core";
import { ORPCError } from "@orpc/server";
import { HEARTBEAT_MS, SESSION_RECHECK_MS } from "./routes/shared.js";

type StreamContext = {
  signal?: AbortSignal;
  stillAuthorized?: () => Promise<boolean>;
};
type StreamSource<Event, Output, Heartbeat> = {
  source: AsyncIterator<Event>;
  heartbeat: () => Heartbeat;
  project: (event: Event) => Output | null | Promise<Output | null>;
};

/** Own a server subscription, including cancellation while its iterator ignores abort. */
export function sessionStream<Event, Output, Heartbeat = Output>(
  context: StreamContext,
  open: (
    signal: AbortSignal,
  ) => StreamSource<Event, Output, Heartbeat> | Promise<StreamSource<Event, Output, Heartbeat>>,
): AsyncGenerator<Output | Heartbeat, void, unknown> {
  const controller = new AbortController();
  let closed = false;
  let failure: unknown;
  let stream: StreamSource<Event, Output, Heartbeat> | undefined;
  let sourceClosed = false;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let authorizedAt = Date.now();
  let authorization: Promise<void> | undefined;

  function closeSource() {
    if (!stream || sourceClosed) return;
    sourceClosed = true;
    try {
      // return() can queue forever behind next(), even after the signal was aborted.
      void Promise.resolve(stream.source.return?.()).catch(() => undefined);
    } catch {
      // Teardown cannot prevent retiring this subscription.
    }
  }
  function close(error?: unknown) {
    if (closed) return;
    closed = true;
    failure = error;
    controller.abort();
    context.signal?.removeEventListener("abort", onAbort);
    clearTimeout(timer);
    closeSource();
    wake?.();
  }
  const onAbort = () => close();
  context.signal?.addEventListener("abort", onAbort, { once: true });
  if (context.signal?.aborted) close();

  function checkAuthorization(): Promise<void> {
    if (authorization) return authorization;
    if (closed || !context.stillAuthorized || Date.now() - authorizedAt < SESSION_RECHECK_MS)
      return Promise.resolve();
    authorization = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return context.stillAuthorized!();
      })
      .then((allowed) => {
        if (!allowed) throw new ORPCError("UNAUTHORIZED");
        authorizedAt = Date.now();
      })
      .finally(() => {
        authorization = undefined;
      });
    return authorization;
  }
  async function monitorAuthorization() {
    if (!context.stillAuthorized) return;
    try {
      while (!closed) {
        await abortableDelay(
          Math.max(0, SESSION_RECHECK_MS - (Date.now() - authorizedAt)),
          controller.signal,
        );
        if (!closed) await withAbort(checkAuthorization(), controller.signal);
      }
    } catch (error) {
      if (!closed) close(error);
    }
  }

  async function* iterate(): AsyncGenerator<Output | Heartbeat, void, unknown> {
    if (closed) return;
    void monitorAuthorization();
    try {
      const opening = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return open(controller.signal);
        })
        .then((opened) => {
          stream = opened;
          if (closed) closeSource();
          return opened;
        });
      const opened = await withAbort(opening, controller.signal);
      let reading = false;
      let next: { result: IteratorResult<Event> } | { error: unknown } | undefined;
      while (!closed) {
        if (!reading && !next) {
          reading = true;
          // Register once per read, rather than retaining another promise reaction per heartbeat.
          void Promise.resolve()
            .then(() => {
              controller.signal.throwIfAborted();
              return opened.source.next();
            })
            .then(
              (result) => {
                if (!closed) {
                  reading = false;
                  next = { result };
                  wake?.();
                }
              },
              (error: unknown) => {
                if (!closed) {
                  reading = false;
                  next = { error };
                  wake?.();
                }
              },
            );
        }
        if (next) {
          const settled = next;
          next = undefined;
          if ("error" in settled) throw settled.error;
          if (settled.result.done) return;
          await withAbort(checkAuthorization(), controller.signal);
          const output = await withAbort(
            Promise.resolve(opened.project(settled.result.value)),
            controller.signal,
          );
          await withAbort(checkAuthorization(), controller.signal);
          if (!closed && output !== null) yield output;
          continue;
        }
        let silent = false;
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(() => {
            silent = true;
            resolve();
          }, HEARTBEAT_MS);
          if (closed || next) resolve();
        });
        wake = undefined;
        clearTimeout(timer);
        if (!closed && silent && !next) {
          await withAbort(checkAuthorization(), controller.signal);
          if (!closed) yield opened.heartbeat();
        }
      }
      if (failure !== undefined) throw failure;
    } catch (error) {
      if (!closed) throw error;
      if (failure !== undefined) throw failure;
    } finally {
      close();
    }
  }
  const iterator = iterate();
  const finish = iterator.return.bind(iterator);
  const fail = iterator.throw.bind(iterator);
  // Intercept close before AsyncGenerator queues it behind a blocked next().
  return Object.assign(iterator, {
    return(value: void | PromiseLike<void>) {
      close();
      return finish(value);
    },
    throw(error: unknown) {
      close(error);
      return fail(error);
    },
  });
}
