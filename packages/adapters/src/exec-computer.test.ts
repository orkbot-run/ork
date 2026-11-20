// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)

import type { AdapterContext, ComputerRef, PortableFile } from "@orkbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ExecComputer, encodeTarEntry, TarReader } from "./exec-computer.js";

const CHUNK_BYTES = 256 * 1024;

function archive(files: PortableFile[]): Buffer {
  return Buffer.concat([
    ...files.flatMap((file) => [...encodeTarEntry(file.path, file.content, file.executable)]),
    Buffer.alloc(1024),
  ]);
}

function readFragments(bytes: Buffer, sizes: number[]): PortableFile[] {
  const reader = new TarReader(64 * 1024 * 1024);
  const files: PortableFile[] = [];
  for (let offset = 0, index = 0; offset < bytes.byteLength; index++) {
    const end = Math.min(offset + sizes[index % sizes.length]!, bytes.byteLength);
    files.push(...reader.push(bytes.subarray(offset, end)));
    offset = end;
  }
  reader.finish();
  return files;
}

describe("computer workspace tar transfer", () => {
  it("bounds large file body chunks and preserves sliced input bytes and padding", () => {
    const backing = Buffer.alloc(CHUNK_BYTES * 3 + 91, 0xa7);
    const content = backing.subarray(19, backing.length - 7);
    const chunks = [...encodeTarEntry("large.bin", content, true)];
    expect(chunks.every((chunk) => chunk.byteLength <= CHUNK_BYTES)).toBe(true);
    expect(chunks.slice(1, -1).map((chunk) => chunk.byteLength)).toEqual([
      CHUNK_BYTES,
      CHUNK_BYTES,
      CHUNK_BYTES,
      65,
    ]);
    expect(Buffer.concat(chunks).subarray(512, 512 + content.byteLength)).toEqual(content);
    expect(Buffer.concat(chunks).byteLength % 512).toBe(0);
    const [file] = readFragments(Buffer.concat(chunks), [997, 1, 509, 13]);
    expect(file?.path).toBe("large.bin");
    expect(file?.executable).toBe(true);
    expect(Buffer.from(file!.content)).toEqual(content);
  });

  it("sends bounded chunks through the import transport", async () => {
    const chunks: Buffer[] = [];
    const computer = new ExecComputer(async function* (
      _computer,
      _command,
      _signal,
      _timeout,
      stdin,
    ) {
      for await (const chunk of stdin!) chunks.push(Buffer.from(chunk));
      yield { type: "exit", code: 0 };
    }, "test");
    const file = { path: "large.bin", content: Buffer.alloc(CHUNK_BYTES * 4 + 3, 0x69) };
    const context: AdapterContext = {
      operationId: "operation",
      traceId: "trace",
      spaceId: "space",
      userId: "user",
      signal: new AbortController().signal,
    };
    const ref: ComputerRef = { id: "box", botId: "bot", kind: "incus", providerRef: "box" };
    await computer.importWorkspace(
      ref,
      (async function* () {
        yield file;
      })(),
      context,
    );
    expect(chunks.every((chunk) => chunk.byteLength <= CHUNK_BYTES)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(archive([file]));
  });

  it.each([[1], [511, 2, 513, 7, 1023, 17]])(
    "handles fragmented headers, PAX paths, bodies, padding and empty files: %j",
    (...sizes) => {
      const files: PortableFile[] = [
        {
          path: `${"folder/".repeat(20)}zażółć.txt`,
          content: Buffer.from("payload"),
          executable: true,
        },
        { path: "empty", content: new Uint8Array() },
        { path: "block.bin", content: Buffer.alloc(512, 0x57) },
        { path: "tail.bin", content: Buffer.alloc(513, 0x91) },
      ];
      expect(readFragments(archive(files), sizes)).toEqual(
        files.map((file) => ({ ...file, content: new Uint8Array(file.content) })),
      );
    },
  );

  it("ignores unsupported entries and keeps their body out of following files", () => {
    const skipped = Buffer.concat([...encodeTarEntry("link", Buffer.alloc(513, 0x22))]);
    skipped.write("2", 156);
    const files = [{ path: "kept", content: Buffer.from("value") }];
    expect(readFragments(Buffer.concat([skipped, archive(files)]), [3, 19, 511])).toEqual(
      files.map((file) => ({ ...file, content: new Uint8Array(file.content) })),
    );
  });

  it("ignores all bytes after the first archive terminator, including later pushes", () => {
    const reader = new TarReader(100);
    const bytes = archive([{ path: "kept", content: Buffer.from("value") }]);
    const garbage = Buffer.alloc(1024 * 1024, 0xff);
    expect(reader.push(Buffer.concat([bytes, garbage]))).toHaveLength(1);
    expect(reader.push(garbage)).toEqual([]);
    expect(reader.push(archive([{ path: "ignored", content: new Uint8Array() }]))).toEqual([]);
    expect(() => reader.finish()).not.toThrow();
  });

  it.each([512, 515, 1023])("rejects truncated bodies or padding at %i bytes", (length) => {
    const reader = new TarReader(100);
    reader.push(archive([{ path: "file", content: Buffer.from("value") }]).subarray(0, length));
    expect(() => reader.finish()).toThrow("workspace archive ended inside a file");
  });

  it("does not reserve a declared PAX body before its bytes arrive", () => {
    const header = Buffer.from([...encodeTarEntry("pax", new Uint8Array())][0]!);
    header.write("x", 156);
    header.write("77777777777\0", 124);
    const allocate = Buffer.allocUnsafe;
    const allocations = vi.spyOn(Buffer, "allocUnsafe").mockImplementation((size) => {
      if (size > CHUNK_BYTES) throw new Error("eager body allocation");
      return allocate(size);
    });
    try {
      const reader = new TarReader(100);
      expect(reader.push(header)).toEqual([]);
      expect(allocations).not.toHaveBeenCalled();
      expect(reader.push(Buffer.from("one byte at a time"))).toEqual([]);
      expect(() => reader.finish()).toThrow("workspace archive ended inside a file");
    } finally {
      allocations.mockRestore();
    }
  });

  it("preserves file size limits and rejects unsafe paths", () => {
    expect(() =>
      new TarReader(2).push(archive([{ path: "file", content: Buffer.from("abc") }])),
    ).toThrow("computer file exceeds 2 bytes");
    expect(() =>
      new TarReader(10).push(archive([{ path: "../escape", content: Buffer.from("abc") }])),
    ).toThrow();
  });
});
