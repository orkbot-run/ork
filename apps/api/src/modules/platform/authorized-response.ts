// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/** End delivery immediately when a stream's workspace authority ends, including a stalled producer. */
export function authorizedResponse(
  response: Response,
  lifetime: {
    signal: AbortSignal;
    dispose(): void;
  },
): Response {
  if (!response.body) {
    lifetime.dispose();
    lifetime.signal.throwIfAborted();
    return response;
  }
  const reader = response.body.getReader();
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    if (closed) return;
    closed = true;
    lifetime.signal.removeEventListener("abort", abort);
    lifetime.dispose();
    try {
      reader.releaseLock();
    } catch {
      /* A stalled read releases after cancellation. */
    }
  };
  const abort = () => {
    if (closed) return;
    controller.error(lifetime.signal.reason ?? new Error("Workspace access revoked"));
    void reader.cancel(lifetime.signal.reason).catch(() => undefined);
    finish();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      lifetime.signal.addEventListener("abort", abort, { once: true });
      if (lifetime.signal.aborted) abort();
    },
    async pull() {
      try {
        lifetime.signal.throwIfAborted();
        const next = await reader.read();
        if (closed) return;
        lifetime.signal.throwIfAborted();
        if (next.done) {
          controller.close();
          finish();
        } else controller.enqueue(next.value);
      } catch (error) {
        if (!closed) {
          controller.error(error);
          finish();
        }
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
      finish();
    },
  });
  return new Response(stream, response);
}
