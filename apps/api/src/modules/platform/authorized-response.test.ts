// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it, vi } from "vitest";
import { authorizedResponse } from "./authorized-response.js";

it("immediately rejects a stalled read and cancels its producer after revocation", async () => {
  const permission = new AbortController();
  const dispose = vi.fn();
  const cancel = vi.fn();
  const source = new Response(new ReadableStream<Uint8Array>({ start() {}, cancel }));
  const response = authorizedResponse(source, { signal: permission.signal, dispose });
  const pending = response.body!.getReader().read();
  permission.abort(new Error("Revoked"));
  await expect(pending).rejects.toThrow("Revoked");
  expect(cancel).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
});
it("discards buffered bytes when authorization ends before delivery", async () => {
  const permission = new AbortController();
  const dispose = vi.fn();
  const response = authorizedResponse(new Response("private workspace content"), {
    signal: permission.signal,
    dispose,
  });
  await Promise.resolve();
  permission.abort(new Error("Revoked"));
  await expect(response.text()).rejects.toThrow("Revoked");
  expect(dispose).toHaveBeenCalledOnce();
});
it("preserves headers and releases authority after normal completion or cancellation", async () => {
  const permission = new AbortController();
  const dispose = vi.fn();
  const response = authorizedResponse(
    new Response("content", { status: 206, headers: { "x-fixture": "header" } }),
    { signal: permission.signal, dispose },
  );
  expect(response.status).toBe(206);
  expect(response.headers.get("x-fixture")).toBe("header");
  expect(await response.text()).toBe("content");
  expect(dispose).toHaveBeenCalledOnce();
  permission.abort();
  expect(dispose).toHaveBeenCalledOnce();
});
