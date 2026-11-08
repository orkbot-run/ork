// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { crc32 } from "node:zlib";
import type { PortableFile } from "@orkbot/adapter-kit";
import { expect, it, vi } from "vitest";
import { archiveBotFiles } from "./bot-file-archive.js";

const limits = { maxBytes: 1024, maxFiles: 256, maxDepth: 16, maxMetadataBytes: 256 * 1024 };
async function* files(path = "nested/file.txt", size = 5) {
  yield { path, content: new Uint8Array(size).fill(7) };
}
it("writes a bounded ordinary ZIP with exact CRC, UTF-8 name and central offsets", async () => {
  const bytes = Buffer.from(
    await archiveBotFiles(files("nested/plik-ż.txt"), limits, new AbortController().signal),
  );
  expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
  const nameLength = bytes.readUInt16LE(26);
  const name = bytes.subarray(30, 30 + nameLength).toString();
  expect(name).toBe("nested/plik-ż.txt");
  const body = bytes.subarray(30 + nameLength, 30 + nameLength + bytes.readUInt32LE(22));
  expect(crc32(body)).toBe(bytes.readUInt32LE(14));
  const end = bytes.length - 22;
  const index = bytes.readUInt32LE(end + 16);
  expect(bytes.readUInt32LE(index)).toBe(0x02014b50);
  expect(bytes.readUInt32LE(index + 42)).toBe(0);
  expect(bytes.readUInt16LE(end + 10)).toBe(1);
});
it.each([
  "../escape",
  "/absolute",
  "nested/../escape",
  "bad\\name",
  "C:/drive",
  "nul\0name",
  "a:stream",
  "CON.txt",
  "bad. ",
  "\ud800",
])("rejects unsafe archive path %j", async (name) => {
  await expect(
    archiveBotFiles(files(name), limits, new AbortController().signal),
  ).rejects.toThrow();
});
it("counts archive headers in addition to input bytes", async () => {
  await expect(
    archiveBotFiles(files("a", 10), { ...limits, maxBytes: 10 }, new AbortController().signal),
  ).rejects.toThrow("attachment limit");
});
it.each([{ maxFiles: 0 }, { maxDepth: 0 }, { maxMetadataBytes: 1 }, { maxBytes: 1 }])(
  "enforces directory consumer bounds %j",
  async (cap) => {
    await expect(
      archiveBotFiles(files(), { ...limits, ...cap }, new AbortController().signal),
    ).rejects.toThrow();
  },
);
it("closes an aborted stalled export without waiting behind its next()", async () => {
  const controller = new AbortController();
  const close = vi.fn(async () => ({ done: true as const, value: undefined }));
  const iterator = {
    next: () => new Promise<IteratorResult<PortableFile>>(() => {}),
    return: close,
  };
  const archiving = archiveBotFiles(
    { [Symbol.asyncIterator]: () => iterator },
    limits,
    controller.signal,
  );
  controller.abort(new Error("cancelled"));
  await expect(archiving).rejects.toThrow("cancelled");
  expect(close).toHaveBeenCalledOnce();
});
it("rejects duplicate names and keeps nested archives opaque", async () => {
  async function* duplicated() {
    yield* files("same");
    yield* files("same");
  }
  await expect(archiveBotFiles(duplicated(), limits, new AbortController().signal)).rejects.toThrow(
    "duplicate",
  );
  expect(
    await archiveBotFiles(files("opaque.zip"), limits, new AbortController().signal),
  ).toBeInstanceOf(Uint8Array);
});
