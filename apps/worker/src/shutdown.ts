// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export const WORKER_SHUTDOWN_IO_MS = 3_000;
export const DEFAULT_RUN_DRAIN_MS = 40 * 60_000;

/** Only a normal signal lets owned runs continue. A fatal error can interrupt an existing drain. */
export function createWorkerShutdown(options: {
  shutdown: AbortController;
  runDrainMs?: number;
  onRunDrainTimeout: () => void;
  stopWork: () => Promise<void>;
  closeResources: () => Promise<void>;
  flush: () => Promise<void>;
}) {
  let stopped: Promise<void> | undefined;
  return (graceful = false): Promise<void> => {
    const drainMs = graceful ? options.runDrainMs : undefined;
    if (drainMs === undefined) options.shutdown.abort();
    if (stopped) return stopped;
    stopped = (async () => {
      const deadline =
        drainMs === undefined
          ? undefined
          : setTimeout(() => {
              if (options.shutdown.signal.aborted) return;
              options.onRunDrainTimeout();
              options.shutdown.abort();
            }, drainMs).unref();
      try {
        try {
          await options.stopWork();
        } finally {
          clearTimeout(deadline);
          options.shutdown.abort();
        }
        await options.closeResources();
      } finally {
        await options.flush();
      }
    })();
    return stopped;
  };
}

/** Bounds I/O during shutdown. Callers keep waiting for active work separately. */
export async function waitForWorkerShutdownIo(
  work: Promise<unknown>,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          onTimeout();
          resolve();
        }, WORKER_SHUTDOWN_IO_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
