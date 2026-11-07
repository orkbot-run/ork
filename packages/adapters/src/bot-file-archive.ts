// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { crc32 } from "node:zlib";
import type { DirectoryExportLimits, PortableFile } from "@orkbot/adapter-kit";
import { withAbort } from "@orkbot/core";
import { normalizeWorkspacePath } from "./computer-support.js";
import { normalizeDesktopWorkspacePath } from "./desktop-sandbox-paths.js";

/** A small, bounded, uncompressed ZIP; nested archives are ordinary opaque files. */
export async function archiveBotFiles(
  files: AsyncIterable<PortableFile>,
  limits: DirectoryExportLimits,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const names = new Set<string>();
  let offset = 0;
  let centralSize = 0;
  let metadata = 0;
  let bytes = 0;
  const iterator = files[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await withAbort(iterator.next(), signal);
      signal.throwIfAborted();
      if (step.done) break;
      const file = step.value;
      const name = Buffer.from(file.path);
      normalizeDesktopWorkspacePath(file.path, "win32");
      if (
        !file.path ||
        file.path !== normalizeWorkspacePath(file.path) ||
        /[\0\\]/u.test(file.path) ||
        /^[a-z]:/iu.test(file.path) ||
        name.length > 4096 ||
        name.toString("utf8") !== file.path ||
        names.has(file.path)
      )
        throw new Error("Directory contains an unsafe or duplicate path");
      if (file.path.split("/").length > limits.maxDepth + 1 || names.size >= limits.maxFiles)
        throw new Error("Directory exceeds its entry or depth limit");
      names.add(file.path);
      metadata += name.length + 64;
      bytes += file.content.byteLength;
      if (metadata > limits.maxMetadataBytes || bytes > limits.maxBytes)
        throw new Error("Directory exceeds its metadata or byte limit");
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0800, 6);
      header.writeUInt16LE(33, 12);
      header.writeUInt32LE(crc32(file.content), 14);
      header.writeUInt32LE(file.content.byteLength, 18);
      header.writeUInt32LE(file.content.byteLength, 22);
      header.writeUInt16LE(name.length, 26);
      const index = Buffer.alloc(46);
      index.writeUInt32LE(0x02014b50, 0);
      index.writeUInt16LE(20, 4);
      header.copy(index, 6, 4, 28);
      index.writeUInt32LE(offset, 42);
      offset += header.length + name.length + file.content.byteLength;
      centralSize += index.length + name.length;
      if (offset + centralSize + 22 > limits.maxBytes)
        throw new Error("Directory archive exceeds the attachment limit");
      local.push(header, name, file.content);
      central.push(index, name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(names.size, 8);
    end.writeUInt16LE(names.size, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    if (offset + centralSize + end.length > limits.maxBytes)
      throw new Error("Directory archive exceeds the attachment limit");
    return Buffer.concat([...local, ...central, end], offset + centralSize + end.length);
  } finally {
    if (iterator.return) {
      const closing = iterator.return();
      if (signal.aborted) void closing.catch(() => undefined);
      else await withAbort(closing, signal);
    }
  }
}
