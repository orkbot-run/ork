// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it, vi } from "vitest";
import type { NativeHttpBridge, NativeHttpContext } from "./native-fetch.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

import { createNativeFetch } from "./native-fetch.js";

function fixture() {
  let active = true;
  const chunks: (string | null)[] = [btoa('{"ok":true}'), null];
  const bridge = {
    open: vi.fn<NativeHttpBridge["open"]>(async () => undefined),
    start: vi.fn<NativeHttpBridge["start"]>(async () => undefined),
    write: vi.fn<NativeHttpBridge["write"]>(async () => true),
    finish: vi.fn<NativeHttpBridge["finish"]>(async () => undefined),
    head: vi.fn<NativeHttpBridge["head"]>(async () => ({
      status: 200,
      headers: [{ name: "content-type", value: "application/json" }],
    })),
    read: vi.fn<NativeHttpBridge["read"]>(async () => chunks.shift() ?? null),
    cancel: vi.fn<NativeHttpBridge["cancel"]>(async () => undefined),
  };
  const context: NativeHttpContext = {
    session: "native-session",
    revision: 7,
    origin: "https://server.example.test",
    current: () => active,
  };
  return {
    bridge,
    chunks,
    fetch: createNativeFetch(bridge, context, () => "request-id"),
    invalidate: () => {
      active = false;
    },
  };
}
const url = "https://server.example.test/api/events?cursor=one";

it("keeps headers and bytes scoped, with no speculative response reads", async () => {
  const f = fixture();
  const response = await f.fetch(url, {
    headers: {
      authorization: "Bearer product-token",
      origin: "orkbot://",
      host: "wrong.test",
      "content-length": "900",
    },
  });
  expect(f.bridge.read).not.toHaveBeenCalled();
  expect(JSON.parse(f.bridge.open.mock.calls[0]![3])).toEqual({
    method: "GET",
    path: "/api/events?cursor=one",
    hasBody: false,
    headers: [{ name: "authorization", value: "Bearer product-token" }],
  });
  expect(response.bodyUsed).toBe(false);
  expect(await response.json()).toEqual({ ok: true });
  expect(response.bodyUsed).toBe(true);
  await expect(response.text()).rejects.toThrow("already used");
  expect(f.bridge.cancel).toHaveBeenCalledExactlyOnceWith("native-session", 7, "request-id");
});

it("uploads a multi-megabyte file in bounded native writes", async () => {
  const f = fixture();
  const bytes = new Uint8Array(2 * 1024 * 1024).fill(66);
  const response = await f.fetch(url, {
    method: "POST",
    body: new Blob([bytes], { type: "application/octet-stream" }),
  });
  await vi.waitFor(() => expect(f.bridge.finish).toHaveBeenCalledOnce());
  expect(f.bridge.write).toHaveBeenCalledTimes(32);
  expect(f.bridge.write.mock.calls.every((args) => args[3].length <= 88 * 1024)).toBe(true);
  const sent = f.bridge.write.mock.calls.map((args) => atob(args[3])).join("");
  expect(sent.length).toBe(bytes.length);
  expect(sent).toBe("B".repeat(bytes.length));
  await response.body!.cancel();
});

it("preserves unicode across bounded string upload boundaries", async () => {
  const f = fixture();
  const body = `${"a".repeat(16383)}🦊${"ą".repeat(40000)}`;
  const response = await f.fetch(url, { method: "POST", body });
  await vi.waitFor(() => expect(f.bridge.finish).toHaveBeenCalledOnce());
  const parts = f.bridge.write.mock.calls.map((args) => Buffer.from(args[3], "base64"));
  expect(Buffer.concat(parts).toString()).toBe(body);
  expect(parts.every((part) => part.length <= 64 * 1024)).toBe(true);
  await response.body!.cancel();
});

it("stops producing a body when the server responds early", async () => {
  const f = fixture();
  f.bridge.write.mockResolvedValue(false);
  const response = await f.fetch(url, { method: "POST", body: new Uint8Array(2 * 1024 * 1024) });
  await vi.waitFor(() => expect(f.bridge.write).toHaveBeenCalledOnce());
  expect(f.bridge.finish).not.toHaveBeenCalled();
  expect(await response.json()).toEqual({ ok: true });
});

it("propagates upload errors without replaying a mutation", async () => {
  const f = fixture();
  f.bridge.write.mockRejectedValue(new Error("upload refused"));
  f.bridge.head.mockImplementation(() => new Promise(() => {}));
  await expect(f.fetch(url, { method: "POST", body: "mutation" })).rejects.toThrow(
    "upload refused",
  );
  expect(f.bridge.open).toHaveBeenCalledOnce();
  expect(f.bridge.cancel).toHaveBeenCalledOnce();
});

it("cancels a pending open immediately and again when it settles late", async () => {
  const f = fixture();
  const open = deferred<void>();
  f.bridge.open.mockReturnValue(open.promise);
  const abort = new AbortController();
  const request = f.fetch(url, { signal: abort.signal });
  abort.abort(new Error("left workspace"));
  await expect(request).rejects.toThrow("left workspace");
  expect(f.bridge.cancel).toHaveBeenCalledOnce();
  open.resolve();
  await vi.waitFor(() => expect(f.bridge.cancel).toHaveBeenCalledTimes(2));
  expect(f.bridge.head).not.toHaveBeenCalled();
  expect(f.bridge.start).not.toHaveBeenCalled();
});

it("does not start requests canceled before dispatch", async () => {
  const f = fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(f.fetch(url, { signal: abort.signal })).rejects.toThrow();
  expect(f.bridge.open).not.toHaveBeenCalled();
});

it("rejects delayed response bytes from another selection", async () => {
  const f = fixture();
  const read = deferred<string>();
  f.bridge.read.mockReturnValueOnce(read.promise);
  const response = await f.fetch(url);
  const reader = response.body!.getReader();
  const next = reader.read();
  await vi.waitFor(() => expect(f.bridge.read).toHaveBeenCalledOnce());
  f.invalidate();
  read.resolve(btoa("private old workspace"));
  await expect(next).rejects.toThrow("changed");
  expect(f.bridge.cancel).toHaveBeenCalledOnce();
});

it("aborts a pending response read and releases its native request", async () => {
  const f = fixture();
  f.bridge.read.mockReturnValue(new Promise(() => {}));
  const abort = new AbortController();
  const response = await f.fetch(url, { signal: abort.signal });
  const next = response.body!.getReader().read();
  abort.abort(new Error("closed stream"));
  await expect(next).rejects.toThrow("closed stream");
  expect(f.bridge.cancel).toHaveBeenCalledOnce();
});

it.each([
  "https://accounts.example.test/api",
  "https://other.example.test/api",
  "https://user:secret@server.example.test/api",
  `${url}#fragment`,
])("refuses routing %s into the selected server", async (input) => {
  const f = fixture();
  await expect(f.fetch(input)).rejects.toThrow();
  expect(f.bridge.open).not.toHaveBeenCalled();
});

it("bounds malformed native response chunks", async () => {
  const f = fixture();
  f.chunks.splice(0, 2, "a".repeat(100000));
  const response = await f.fetch(url);
  await expect(response.text()).rejects.toThrow("limit");
  expect(f.bridge.cancel).toHaveBeenCalledOnce();
});

it("clones a readable response without consuming either branch early", async () => {
  const f = fixture();
  const response = await f.fetch(url);
  const clone = response.clone();
  expect(response.bodyUsed).toBe(false);
  expect(clone.bodyUsed).toBe(false);
  expect(await clone.json()).toEqual({ ok: true });
  expect(await response.json()).toEqual({ ok: true });
  expect(f.bridge.cancel).toHaveBeenCalledOnce();
});

it.each([204, 205, 304])(
  "closes a bodyless %s response without waiting for a pull",
  async (status) => {
    const f = fixture();
    f.bridge.head.mockResolvedValue({ status, headers: [] });
    const response = await f.fetch(url);
    expect(response.body).toBeNull();
    expect(f.bridge.read).not.toHaveBeenCalled();
    expect(f.bridge.cancel).toHaveBeenCalledOnce();
  },
);
