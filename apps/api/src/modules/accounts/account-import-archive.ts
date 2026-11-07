// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { FileHandle } from "node:fs/promises";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { crc32, createInflateRaw } from "node:zlib";

export interface ZipArchiveLimits {
  bodyBytes: number;
  metadataBytes: number;
  entries: number;
  nameBytes: number;
}

export class ZipArchiveError extends Error {
  constructor(readonly oversized = false) {
    super(oversized ? "Archive exceeds its limit" : "Invalid ZIP archive");
  }
}

const invalid = () => new ZipArchiveError();
const oversized = () => new ZipArchiveError(true);
const CHUNK_BYTES = 64 * 1024;

interface Entry {
  name: string;
  nameBytes: Buffer;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  unpacked: number;
  offset: number;
  start: number;
}

async function read(
  file: FileHandle,
  offset: number,
  length: number,
  end: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > end)
    throw invalid();
  const buffer = Buffer.alloc(length);
  let position = 0;
  while (position < length) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(buffer, position, length - position, offset + position);
    if (!bytesRead) throw invalid();
    position += bytesRead;
  }
  signal?.throwIfAborted();
  return buffer;
}

function uint64(buffer: Buffer, offset: number): number {
  if (offset + 8 > buffer.length) throw invalid();
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
  return Number(value);
}

/** ZIP64 fields occur only for sentinel values, in the order prescribed by the ZIP format. */
function extendedSizes<T extends number[]>(
  extra: Buffer,
  values: [...T],
): { [K in keyof T]: number } {
  let zip64: Buffer | undefined;
  for (let cursor = 0; cursor < extra.length; ) {
    if (cursor + 4 > extra.length) throw invalid();
    const kind = extra.readUInt16LE(cursor);
    const length = extra.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + length > extra.length) throw invalid();
    if (kind === 1) {
      if (zip64) throw invalid();
      zip64 = extra.subarray(cursor, cursor + length);
    }
    cursor += length;
  }
  let cursor = 0;
  return values.map((value) => {
    if (value !== 0xffffffff) return value;
    if (!zip64) throw invalid();
    const next = uint64(zip64, cursor);
    cursor += 8;
    return next;
  }) as { [K in keyof T]: number };
}

async function directory(
  file: FileHandle,
  size: number,
  limits: ZipArchiveLimits,
  signal?: AbortSignal,
): Promise<Entry[]> {
  signal?.throwIfAborted();
  if (size < 22) throw invalid();
  const tailStart = Math.max(0, size - 22 - 0xffff);
  const tail = await read(file, tailStart, size - tailStart, size, signal);
  let end = tail.length - 22;
  while (
    end >= 0 &&
    (tail.readUInt32LE(end) !== 0x06054b50 ||
      end + 22 + tail.readUInt16LE(end + 20) !== tail.length)
  )
    end--;
  if (end < 0) throw invalid();
  if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw invalid();
  let count = tail.readUInt16LE(end + 10);
  if (tail.readUInt16LE(end + 8) !== count) throw invalid();
  let length = tail.readUInt32LE(end + 12);
  let offset = tail.readUInt32LE(end + 16);
  let directoryEnd = tailStart + end;
  const possibleLocator =
    directoryEnd >= 20 ? await read(file, directoryEnd - 20, 20, size, signal) : undefined;
  if (
    count === 0xffff ||
    length === 0xffffffff ||
    offset === 0xffffffff ||
    possibleLocator?.readUInt32LE(0) === 0x07064b50
  ) {
    const locatorOffset = directoryEnd - 20;
    const locator = await read(file, locatorOffset, 20, size, signal);
    if (
      locator.readUInt32LE(0) !== 0x07064b50 ||
      locator.readUInt32LE(4) !== 0 ||
      locator.readUInt32LE(16) !== 1
    )
      throw invalid();
    const zip64Offset = uint64(locator, 8);
    const zip64 = await read(file, zip64Offset, 56, locatorOffset, signal);
    const recordLength = uint64(zip64, 4);
    if (recordLength > limits.metadataBytes) throw oversized();
    if (
      zip64.readUInt32LE(0) !== 0x06064b50 ||
      recordLength < 44 ||
      zip64Offset + 12 + recordLength !== locatorOffset ||
      zip64.readUInt32LE(16) !== 0 ||
      zip64.readUInt32LE(20) !== 0 ||
      uint64(zip64, 24) !== uint64(zip64, 32)
    )
      throw invalid();
    const zip64Count = uint64(zip64, 32);
    const zip64Length = uint64(zip64, 40);
    const zip64Directory = uint64(zip64, 48);
    if (
      (count !== 0xffff && count !== zip64Count) ||
      (length !== 0xffffffff && length !== zip64Length) ||
      (offset !== 0xffffffff && offset !== zip64Directory)
    )
      throw invalid();
    count = zip64Count;
    length = zip64Length;
    offset = zip64Directory;
    directoryEnd = zip64Offset;
  }
  if (count > limits.entries || length > limits.metadataBytes) throw oversized();
  if (!count || offset + length !== directoryEnd) throw invalid();
  let metadata = length + size - directoryEnd;
  if (metadata > limits.metadataBytes) throw oversized();
  let cursor = offset;
  const entries: Entry[] = [];
  for (let index = 0; index < count; index++) {
    signal?.throwIfAborted();
    const header = await read(file, cursor, 46, directoryEnd, signal);
    if (header.readUInt32LE(0) !== 0x02014b50 || header.readUInt16LE(34) !== 0) throw invalid();
    const nameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const commentLength = header.readUInt16LE(32);
    if (nameLength > limits.nameBytes) throw oversized();
    const fields = await read(
      file,
      cursor + 46,
      nameLength + extraLength + commentLength,
      directoryEnd,
      signal,
    );
    const nameBytes = fields.subarray(0, nameLength);
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    } catch {
      throw invalid();
    }
    const [unpacked, compressed, localOffset] = extendedSizes(
      fields.subarray(nameLength, nameLength + extraLength),
      [header.readUInt32LE(24), header.readUInt32LE(20), header.readUInt32LE(42)],
    );
    const flags = header.readUInt16LE(8);
    const method = header.readUInt16LE(10);
    if ((flags & ~0x080e) !== 0 || (method !== 0 && method !== 8)) throw invalid();
    entries.push({
      name,
      nameBytes,
      flags,
      method,
      crc: header.readUInt32LE(16),
      compressed,
      unpacked,
      offset: localOffset,
      start: 0,
    });
    cursor += 46 + fields.length;
  }
  if (cursor !== directoryEnd) throw invalid();
  entries.sort((a, b) => a.offset - b.offset);
  if (entries[0]?.offset !== 0) throw invalid();
  for (let index = 0; index < entries.length; index++) {
    signal?.throwIfAborted();
    const entry = entries[index]!;
    const nextOffset = entries[index + 1]?.offset ?? offset;
    const header = await read(file, entry.offset, 30, nextOffset, signal);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    metadata += 30 + nameLength + extraLength;
    if (metadata > limits.metadataBytes || nameLength > limits.nameBytes) throw oversized();
    if (
      header.readUInt32LE(0) !== 0x04034b50 ||
      header.readUInt16LE(6) !== entry.flags ||
      header.readUInt16LE(8) !== entry.method
    )
      throw invalid();
    const fields = await read(
      file,
      entry.offset + 30,
      nameLength + extraLength,
      nextOffset,
      signal,
    );
    if (!fields.subarray(0, nameLength).equals(entry.nameBytes)) throw invalid();
    const [unpacked, compressed] = extendedSizes(fields.subarray(nameLength), [
      header.readUInt32LE(22),
      header.readUInt32LE(18),
    ]);
    const descriptor = Boolean(entry.flags & 8);
    if (
      (unpacked !== entry.unpacked && (!descriptor || unpacked !== 0)) ||
      (compressed !== entry.compressed && (!descriptor || compressed !== 0)) ||
      (header.readUInt32LE(14) !== entry.crc && (!descriptor || header.readUInt32LE(14) !== 0)) ||
      (entry.method === 0 && entry.compressed !== entry.unpacked)
    )
      throw invalid();
    entry.start = entry.offset + 30 + fields.length;
    const dataEnd = entry.start + entry.compressed;
    if (!Number.isSafeInteger(dataEnd) || dataEnd > nextOffset) throw invalid();
    if (!descriptor) {
      if (dataEnd !== nextOffset) throw invalid();
      continue;
    }
    const remaining = nextOffset - dataEnd;
    if (![12, 16, 20, 24].includes(remaining)) throw invalid();
    const trailer = await read(file, dataEnd, remaining, nextOffset, signal);
    const signed = remaining === 16 || remaining === 24;
    const position = signed ? 4 : 0;
    const wide = remaining >= 20;
    if (signed && trailer.readUInt32LE(0) !== 0x08074b50) throw invalid();
    if (
      trailer.readUInt32LE(position) !== entry.crc ||
      (wide ? uint64(trailer, position + 4) : trailer.readUInt32LE(position + 4)) !==
        entry.compressed ||
      (wide ? uint64(trailer, position + 12) : trailer.readUInt32LE(position + 8)) !==
        entry.unpacked
    )
      throw invalid();
  }
  return entries;
}

async function* compressedChunks(
  file: FileHandle,
  entry: Entry,
  signal?: AbortSignal,
): AsyncIterable<Buffer> {
  for (let offset = 0; offset < entry.compressed; offset += CHUNK_BYTES)
    yield await read(
      file,
      entry.start + offset,
      Math.min(CHUNK_BYTES, entry.compressed - offset),
      entry.start + entry.compressed,
      signal,
    );
}

async function* contents(
  file: FileHandle,
  entry: Entry,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  signal?.throwIfAborted();
  const source = Readable.from(compressedChunks(file, entry, signal));
  const inflate = entry.method === 8 ? createInflateRaw() : undefined;
  const stream = inflate ? source.pipe(inflate) : source;
  let size = 0;
  let checksum = 0;
  // pipe does not forward source errors; close both sides on every failure or early consumer return.
  const sourceError = (error: Error) => stream.destroy(error);
  source.on("error", sourceError);
  const abort = () => {
    const error = signal?.reason instanceof Error ? signal.reason : new Error("Request aborted");
    source.destroy(error);
    stream.destroy(error);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      size += chunk.byteLength;
      if (size > entry.unpacked) throw invalid();
      checksum = crc32(chunk, checksum);
      yield chunk;
    }
    if (
      size !== entry.unpacked ||
      checksum !== entry.crc ||
      (inflate && inflate.bytesWritten !== entry.compressed)
    )
      throw invalid();
  } catch {
    signal?.throwIfAborted();
    throw invalid();
  } finally {
    signal?.removeEventListener("abort", abort);
    source.off("error", sourceError);
    source.destroy();
    inflate?.destroy();
  }
}

/** Spool only the bounded upload, then read exact central-directory ranges, never ZIP signatures in file contents. */
export async function readZipArchive(
  body: AsyncIterable<Uint8Array>,
  limits: ZipArchiveLimits,
  consume: (name: string, unpacked: number, chunks: AsyncIterable<Uint8Array>) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const directoryPath = await mkdtemp(path.join(tmpdir(), "orkbot-account-archive-"));
  let file: FileHandle | undefined;
  try {
    file = await open(path.join(directoryPath, "upload.zip"), "wx+", 0o600);
    let size = 0;
    for await (const chunk of body) {
      signal?.throwIfAborted();
      size += chunk.byteLength;
      if (size > limits.bodyBytes) throw oversized();
      for (let offset = 0; offset < chunk.byteLength; ) {
        signal?.throwIfAborted();
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
        if (!bytesWritten) throw new Error("Could not spool account archive");
        offset += bytesWritten;
      }
    }
    const entries = await directory(file, size, limits, signal);
    for (const entry of entries) {
      signal?.throwIfAborted();
      await consume(entry.name, entry.unpacked, contents(file, entry, signal));
    }
    signal?.throwIfAborted();
  } finally {
    try {
      await file?.close();
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  }
}
