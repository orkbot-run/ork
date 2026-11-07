// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/** A deadline belongs to a whole request, including its body and nested recovery calls. */
export function requestSignal(parent?: AbortSignal, timeoutMs?: number | null) {
  if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs < 0))
    throw new RangeError("Request timeout must be a nonnegative finite number.");
  if (parent && timeoutMs == null) return { signal: parent, dispose() {} };
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason ?? new Error("Request canceled"));
  if (parent?.aborted) cancel();
  else parent?.addEventListener("abort", cancel, { once: true });
  const timer =
    timeoutMs == null
      ? undefined
      : setTimeout(() => {
          const error = new Error("Request timed out");
          error.name = "TimeoutError";
          controller.abort(error);
        }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", cancel);
    },
  };
}
