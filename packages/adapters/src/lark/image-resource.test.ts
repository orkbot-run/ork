// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Readable } from "node:stream";
import type { HttpInstance } from "@larksuiteoapi/node-sdk";
import * as sdk from "@larksuiteoapi/node-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { fetchImageResource } from "./image-resource.js";
import type { LarkAdapterConfig } from "./lazy-adapter.js";
import { Domain } from "./thread-id.js";

let nextApp = 0;
function setup() {
  const request = vi.fn();
  const post = vi
    .fn()
    .mockResolvedValue({ code: 0, tenant_access_token: "synthetic-bearer", expire: 7200 });
  const httpInstance: HttpInstance = {
    request,
    post,
    get: request,
    delete: request,
    head: request,
    options: request,
    put: request,
    patch: request,
  };
  const config: LarkAdapterConfig = {
    appId: `image-resource-fixture-${++nextApp}`,
    appSecret: "synthetic-secret",
    domain: Domain.Lark,
    verificationToken: "test",
    encryptKey: "",
    httpInstance,
  };
  return { request, post, fetch: () => fetchImageResource(sdk, config, "om-origin", "img-origin") };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("bounds a cold token refresh and prevents a resource request after a late token", async () => {
  const { post, request, fetch } = setup();
  let finish!: (value: unknown) => void;
  post.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.useFakeTimers();
  const result = fetch();
  const rejected = expect(result).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(2_000);
  await rejected;
  expect(post).toHaveBeenCalledOnce();
  expect(post.mock.calls[0]?.[2]).toMatchObject({
    signal: expect.any(AbortSignal),
    maxRedirects: 0,
    timeout: 2_000,
  });
  expect(post.mock.calls[0]?.[2].signal.aborted).toBe(true);
  finish({ code: 0, tenant_access_token: "late-token", expire: 7200 });
  await vi.advanceTimersByTimeAsync(0);
  expect(request).not.toHaveBeenCalled();
});

it("destroys a late resource response even if the injected transport ignores abort", async () => {
  const { request, fetch } = setup();
  let finish!: (value: unknown) => void;
  request.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.useFakeTimers();
  const result = fetch();
  const rejected = expect(result).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(2_000);
  await rejected;
  const stream = new Readable({ read() {} });
  finish({ data: stream, headers: { "content-type": "image/png" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(stream.destroyed).toBe(true);
});

it.each(["token", "resource"])(
  "never logs or exposes raw %s errors containing credentials",
  async (stage) => {
    const { request, post, fetch } = setup();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = Object.assign(new Error("synthetic-bearer synthetic-secret"), {
      config: {
        headers: { Authorization: "Bearer synthetic-bearer" },
        data: { app_secret: "synthetic-secret" },
      },
    });
    (stage === "token" ? post : request).mockRejectedValue(raw);
    await expect(fetch()).rejects.toThrow(/^Image resource unavailable$/);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  },
);

it("rejects declared oversize before reading and releases its stream", async () => {
  const { request, fetch } = setup();
  const read = vi.fn();
  const stream = new Readable({ read });
  request.mockResolvedValue({
    data: stream,
    headers: { "content-type": "image/png", "content-length": String(11 * 1024 * 1024) },
  });
  await expect(fetch()).rejects.toThrow("unavailable");
  expect(read).not.toHaveBeenCalled();
  expect(stream.destroyed).toBe(true);
});

it.each([
  ["image/png; charset=binary", "89504e470d0a1a0a", "image/png"],
  ["image/jpeg", "ffd8ffe0", "image/jpeg"],
  ["image/gif", "474946383961", "image/gif"],
  ["image/webp", "524946460000000057454250", "image/webp"],
])("keeps the verified resource type %s", async (header, hex, mimeType) => {
  const { request, fetch } = setup();
  const bytes = Buffer.from(hex, "hex");
  request.mockResolvedValue({ data: Readable.from([bytes]), headers: { "content-type": header } });
  expect(await fetch()).toEqual({ bytes, mimeType });
  expect(request.mock.calls[0]?.[0]).toMatchObject({
    url: "https://open.larksuite.com/open-apis/im/v1/messages/om-origin/resources/img-origin",
    params: { type: "image" },
  });
});
