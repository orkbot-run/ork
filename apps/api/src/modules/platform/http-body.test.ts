// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it, vi } from "vitest";
import { readBoundedBody, readBoundedBodyBytes } from "./http-body.js";

function streamed(chunks: Uint8Array[], headers?: Record<string, string>) {
  return new Request("https://example.test", {
    method: "POST",
    headers,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("bounded request bodies", () => {
  it.each([Infinity, -Infinity, NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "requires a finite nonnegative integer limit: %s",
    async (limit) => {
      await expect(
        readBoundedBodyBytes(new Request("https://example.test"), limit),
      ).rejects.toThrow(RangeError);
    },
  );

  it("preserves bytes and multibyte text across chunk boundaries", async () => {
    const chunks = [new Uint8Array([0x61, 0xe2]), new Uint8Array([0x82, 0xac, 0xff])];
    await expect(readBoundedBodyBytes(streamed(chunks), 5)).resolves.toEqual(
      new Uint8Array([0x61, 0xe2, 0x82, 0xac, 0xff]),
    );
    await expect(readBoundedBody(streamed(chunks), 5)).resolves.toBe("a€�");
  });

  it.each(["1000000000000", "Infinity", "-1", "invalid"])(
    "rejects oversized or invalid declared length %s without reading",
    async (length) => {
      const request = streamed([], { "content-length": length });
      const read = vi.spyOn(request.body!, "getReader");
      await expect(readBoundedBodyBytes(request, 8)).resolves.toBeNull();
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("uses received bytes even for a large allowed declared length", async () => {
    await expect(
      readBoundedBodyBytes(
        streamed([], { "content-length": String(Number.MAX_SAFE_INTEGER) }),
        Number.MAX_SAFE_INTEGER,
      ),
    ).resolves.toEqual(new Uint8Array(0));
  });

  it("enforces the streamed limit even when the declared length is smaller", async () => {
    await expect(
      readBoundedBodyBytes(
        streamed([new Uint8Array(3), new Uint8Array(3)], { "content-length": "1" }),
        5,
      ),
    ).resolves.toBeNull();
  });

  it("propagates stream read errors", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error("read failed"));
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readBoundedBodyBytes(request, 8)).rejects.toThrow("read failed");
  });
});
