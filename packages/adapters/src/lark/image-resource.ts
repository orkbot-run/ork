// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Readable } from "node:stream";
import type * as LarkSdk from "@larksuiteoapi/node-sdk";
import type { HttpInstance, HttpRequestOptions } from "@larksuiteoapi/node-sdk";
import { ATTACHMENT_MAX_BYTES, isAttachmentImageMimeType } from "@orkbot/contracts";
import { withAbort } from "@orkbot/core";
import type { LarkAdapterConfig } from "./lazy-adapter.js";

const DOWNLOAD_MS = 2_000;

/** Opaque resource identifiers are a single path segment, never a URL. */
export function imageResourceKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
}

function verifiedImageType(bytes: Buffer, reported: string): string {
  const type = reported.split(";", 1)[0]!.trim().toLowerCase();
  const matches =
    (type === "image/png" && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
    (type === "image/jpeg" && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) ||
    (type === "image/gif" &&
      ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) ||
    (type === "image/webp" &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP");
  if (!matches) throw new Error("Image resource type is unavailable");
  return type;
}

/** The official SDK keeps tenant credentials and domains; this client bounds token and resource IO. */
export async function fetchImageResource(
  sdk: typeof LarkSdk,
  config: LarkAdapterConfig,
  messageId: string,
  key: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (!imageResourceKey(messageId) || !imageResourceKey(key))
    throw new Error("Invalid image resource");
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(
    () => controller.abort(new Error("Image download timed out")),
    DOWNLOAD_MS,
  );
  // The SDK's default transport unwraps Axios responses before fulfilling this interface.
  const transport: HttpInstance = config.httpInstance ?? (sdk.defaultHttpInstance as HttpInstance);
  let stream: Readable | undefined;
  const options = <D>(input?: HttpRequestOptions<D>) => ({
    ...input,
    timeout: DOWNLOAD_MS,
    maxRedirects: 0,
    signal,
  });
  const run = <T>(operation: () => Promise<T>, streamed = false): Promise<T> => {
    signal.throwIfAborted();
    const pending = operation();
    if (streamed) {
      void pending
        .then((result) => {
          if (signal.aborted) (result as { data?: Readable }).data?.destroy();
        })
        .catch(() => {});
    }
    return withAbort(pending, signal);
  };
  const httpInstance: HttpInstance = {
    request: (input) =>
      run(() => transport.request(options(input)), input.responseType === "stream"),
    get: (url, input) => run(() => transport.get(url, options(input))),
    delete: (url, input) => run(() => transport.delete(url, options(input))),
    head: (url, input) => run(() => transport.head(url, options(input))),
    options: (url, input) => run(() => transport.options(url, options(input))),
    post: (url, data, input) => run(() => transport.post(url, data, options(input))),
    put: (url, data, input) => run(() => transport.put(url, data, options(input))),
    patch: (url, data, input) => run(() => transport.patch(url, data, options(input))),
  };
  // SDK errors can contain request credentials; expose only the caller's bounded failure.
  const silent = () => {};
  const client = new sdk.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain,
    httpInstance,
    logger: { trace: silent, debug: silent, info: silent, warn: silent, error: silent },
  });
  try {
    const response = await withAbort(
      client.im.messageResource.get({
        path: { message_id: messageId, file_key: key },
        params: { type: "image" },
      }),
      signal,
    );
    stream = response.getReadableStream();
    signal.throwIfAborted();
    const headers = new Headers(response.headers);
    const mimeType = (headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (!isAttachmentImageMimeType(mimeType)) throw new Error("Image resource type is unavailable");
    const length = Number(headers.get("content-length") ?? 0);
    if (Number.isFinite(length) && length > ATTACHMENT_MAX_BYTES)
      throw new Error("Image resource exceeds the attachment limit");
    const chunks: Buffer[] = [];
    let size = 0;
    const iterator = stream[Symbol.asyncIterator]();
    for (;;) {
      const part = await withAbort(iterator.next(), signal);
      if (part.done) break;
      const chunk = Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value);
      size += chunk.byteLength;
      if (size > ATTACHMENT_MAX_BYTES)
        throw new Error("Image resource exceeds the attachment limit");
      chunks.push(chunk);
    }
    if (!size) throw new Error("Image resource is empty");
    const bytes = Buffer.concat(chunks, size);
    return { bytes, mimeType: verifiedImageType(bytes, mimeType) };
  } catch {
    if (signal.aborted) throw new Error("Image download timed out");
    throw new Error("Image resource unavailable");
  } finally {
    clearTimeout(timer);
    controller.abort();
    stream?.destroy();
  }
}
