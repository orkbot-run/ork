// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it } from "vitest";
import { throwIfAborted } from "./index.js";

describe("portable abort guard", () => {
  it("accepts an absent or active signal without a native abort guard", () => {
    expect(() => throwIfAborted()).not.toThrow();
    expect(() => throwIfAborted({ aborted: false } as AbortSignal)).not.toThrow();
  });

  it.each([new Error("Retired request"), "Canceled", null, false, 0])(
    "preserves the exact cancellation reason %s",
    (reason) => {
      let actual: unknown;
      let thrown = false;
      try {
        throwIfAborted({ aborted: true, reason } as AbortSignal);
      } catch (error) {
        thrown = true;
        actual = error;
      }
      expect(thrown).toBe(true);
      expect(actual).toBe(reason);
    },
  );

  it("supplies AbortError when a legacy signal has no reason", () => {
    expect(() => throwIfAborted({ aborted: true } as AbortSignal)).toThrow(
      expect.objectContaining({ name: "AbortError", message: "Request canceled" }),
    );
  });
});
