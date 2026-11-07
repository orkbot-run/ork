// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/** Give an interrupted maintenance command time to finish its current write and release resources. */
export function migrationSignals(graceMs = 30_000) {
  const controller = new AbortController();
  let exitCode: number | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = (code: number) => {
    if (exitCode !== undefined) return;
    exitCode = code;
    process.exitCode = code;
    deadline = setTimeout(() => process.exit(code), graceMs);
    controller.abort();
  };
  const interrupt = () => stop(130);
  const terminate = () => stop(143);
  // Keep handling repeated signals while the current write and cleanup drain.
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  return {
    signal: controller.signal,
    finish() {
      if (exitCode !== undefined) {
        process.exitCode = exitCode;
        // Do not delay a natural exit, but retain the bound if a dependency leaves a handle open.
        deadline?.unref();
      } else {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", terminate);
      }
    },
  };
}
