// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache tests are preserved. Native response coverage is an Ork addition.

import { describe, expect, it, vi } from "vitest";
import {
  isUnauthorizedError,
  ResponseBodyTooLargeError,
  readBoundedJsonResponse,
} from "./http-response.js";

describe("readBoundedJsonResponse", () => {
  function nativeResponse(body: BodyInit | null, headers: Record<string, string>) {
    const response = new Response(body, { headers });
    vi.spyOn(response, "type", "get").mockReturnValue("basic");
    return response;
  }

  it("uses native consumption for bounded uncompressed same-origin responses", async () => {
    const response = nativeResponse('{"ok":true}', { "content-length": "11" });
    const arrayBuffer = vi.spyOn(response, "arrayBuffer");
    await expect(
      readBoundedJsonResponse(response, 64, undefined, { nativeFramed: true }),
    ).resolves.toEqual({ ok: true });
    expect(arrayBuffer).toHaveBeenCalledOnce();
  });

  it.each<{ type: ResponseType; headers: Record<string, string> }>([
    { type: "basic" as const, headers: {} },
    { type: "basic" as const, headers: { "content-length": "11", "content-encoding": "gzip" } },
    { type: "cors" as const, headers: { "content-length": "11" } },
  ])(
    "keeps streaming limits when native framing is not trustworthy: %j",
    async ({ type, headers }) => {
      const response = new Response('{"ok":true}', { headers });
      vi.spyOn(response, "type", "get").mockReturnValue(type);
      const arrayBuffer = vi.spyOn(response, "arrayBuffer");
      await expect(
        readBoundedJsonResponse(response, 64, undefined, { nativeFramed: true }),
      ).resolves.toEqual({ ok: true });
      expect(arrayBuffer).not.toHaveBeenCalled();
    },
  );

  it("rejects a native response exceeding its declared length", async () => {
    const response = nativeResponse(`"${"x".repeat(64)}"`, { "content-length": "1" });
    await expect(
      readBoundedJsonResponse(response, 64, undefined, { nativeFramed: true }),
    ).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
  });

  it("rejects promptly on abort while native consumption is pending", async () => {
    const cancel = vi.fn();
    const response = nativeResponse(new ReadableStream({ cancel }), { "content-length": "10" });
    vi.spyOn(response, "arrayBuffer").mockReturnValue(new Promise<ArrayBuffer>(() => {}));
    const controller = new AbortController();
    const pending = readBoundedJsonResponse(response, 64, controller.signal, {
      nativeFramed: true,
    });
    controller.abort(new Error("request timed out"));
    await expect(pending).rejects.toThrow("request timed out");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("cancels a framed body on an independent signal unless native framing is explicitly enabled", async () => {
    const cancel = vi.fn();
    const response = nativeResponse(new ReadableStream({ cancel }), { "content-length": "10" });
    const arrayBuffer = vi.spyOn(response, "arrayBuffer");
    const controller = new AbortController();
    const pending = readBoundedJsonResponse(response, 64, controller.signal);
    controller.abort(new Error("request timed out"));
    await expect(pending).rejects.toThrow("request timed out");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("parses a fragmented JSON response", async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('{"ok":'));
          controller.enqueue(encoder.encode("true}"));
          controller.close();
        },
      }),
    );

    await expect(readBoundedJsonResponse(response, 64)).resolves.toEqual({ ok: true });
  });

  it("rejects and cancels a response with an oversized declared length", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": "65" },
    });

    await expect(readBoundedJsonResponse(response, 64)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("rejects and cancels a streamed response that crosses the limit", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(65));
        },
        cancel,
      }),
    );

    await expect(readBoundedJsonResponse(response, 64)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("aborts a stalled body read", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const controller = new AbortController();
    const pending = readBoundedJsonResponse(response, 64, controller.signal);

    controller.abort(new Error("request timed out"));

    await expect(pending).rejects.toThrow("request timed out");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("does not read a body once the request is already aborted", async () => {
    const signal = AbortSignal.abort(new Error("request timed out"));

    await expect(readBoundedJsonResponse(new Response('{"ok":true}'), 64, signal)).rejects.toThrow(
      "request timed out",
    );
  });

  it("rejects malformed JSON after a complete bounded read", async () => {
    await expect(readBoundedJsonResponse(new Response("not-json"), 64)).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });
});

describe("isUnauthorizedError", () => {
  it("recognizes only a 401 status", () => {
    expect(isUnauthorizedError({ status: 401 })).toBe(true);
    expect(isUnauthorizedError({ status: 403 })).toBe(false);
    expect(isUnauthorizedError(new Error("401"))).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
  });
});
