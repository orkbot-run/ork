// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved; bounded byte-reading changes follow LICENSE.md.

/** Reads a request body without buffering more than maxBytes. */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
  const decoder = new TextDecoder();
  let body = "";
  const bytes = await consumeBodyChunks(request, maxBytes, (chunk) => {
    body += decoder.decode(chunk, { stream: true });
  });
  return bytes === null ? null : body + decoder.decode();
}

/** Buffers only received bytes; a claimed Content-Length never determines allocation size. */
export async function readBoundedBodyBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  const bytes = await consumeBodyChunks(request, maxBytes, (chunk) => chunks.push(chunk));
  if (bytes === null) return null;
  if (chunks.length === 1) return chunks[0]!;
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function consumeBodyChunks(
  request: Request,
  maxBytes: number,
  consume: (chunk: Uint8Array) => void,
): Promise<number | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a nonnegative safe integer");
  }
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maxBytes) {
      cancelBody(request.body);
      return null;
    }
  }

  if (!request.body) return 0;

  const reader = request.body.getReader();
  let bytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        cancelBody(reader);
        return null;
      }
      if (value.byteLength > 0) consume(value);
    }
    return bytes;
  } finally {
    reader.releaseLock();
  }
}

/** Best-effort body/reader cancel; must not delay a rejection response. */
export function cancelBody(body: { cancel(): Promise<void> } | null): void {
  try {
    void body?.cancel().catch(() => undefined);
  } catch {
    // Ignore cancel failures.
  }
}
