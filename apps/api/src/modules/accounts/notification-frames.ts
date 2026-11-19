// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/** Give each source one outstanding read. A busy source cannot starve a ready one. */
export async function* mergeNotificationFrames<Frame>(
  sources: AsyncIterator<Frame>[],
  signal: AbortSignal,
): AsyncGenerator<Frame> {
  const queue: Array<{ source: AsyncIterator<Frame>; frame: Frame }> = [];
  let remaining = sources.length;
  let failure: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  const onAbort = () => wake?.();

  const read = (source: AsyncIterator<Frame>) => {
    void Promise.resolve()
      .then(() => source.next())
      .then(
        (result) => {
          if (result.done) remaining--;
          else queue.push({ source, frame: result.value });
          wake?.();
        },
        (error: unknown) => {
          failure = { error };
          wake?.();
        },
      );
  };

  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (const source of sources) read(source);
    while (!signal.aborted) {
      if (failure) throw failure.error;
      const next = queue.shift();
      if (next) {
        read(next.source);
        yield next.frame;
      } else if (!remaining) {
        return;
      } else {
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (signal.aborted) resolve();
        });
        wake = undefined;
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    for (const source of sources) {
      void Promise.resolve()
        .then(() => source.return?.())
        .catch(() => undefined);
    }
  }
}
