// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import * as fs from "node:fs/promises";
import { crc32 } from "node:zlib";
import { Zip, ZipPassThrough } from "fflate";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountImportDeps, ArchiveSink } from "./account-import.js";
import { ACCOUNT_IMPORT_LIMITS, mountAccountImportRoute, readArchive } from "./account-import.js";
import { buildArchive, chunked } from "./account-import.test-support.js";
import { readZipArchive } from "./account-import-archive.js";

vi.mock("node:fs/promises", { spy: true });
afterEach(() => vi.restoreAllMocks());

const limits = { ...ACCOUNT_IMPORT_LIMITS, artifactBytes: 1024 * 1024 };

function storedArchive(files: Array<[string, Uint8Array]>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const archive = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [name, content] of files) {
    const entry = new ZipPassThrough(name);
    archive.add(entry);
    entry.push(content, true);
  }
  archive.end();
  return Buffer.concat(chunks);
}

/** A small but genuine ZIP64 archive exercises every 64-bit bounds field without large allocations. */
function zip64(): Buffer {
  const name = Buffer.from("manifest.json");
  const body = Buffer.from("{}");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(45, 4);
  local.writeUInt32LE(crc32(body), 14);
  local.writeUInt32LE(0xffffffff, 18);
  local.writeUInt32LE(0xffffffff, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(20, 28);
  const localExtra = Buffer.alloc(20);
  localExtra.writeUInt16LE(1, 0);
  localExtra.writeUInt16LE(16, 2);
  localExtra.writeBigUInt64LE(2n, 4);
  localExtra.writeBigUInt64LE(2n, 12);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(45, 6);
  central.writeUInt32LE(crc32(body), 16);
  central.writeUInt32LE(0xffffffff, 20);
  central.writeUInt32LE(0xffffffff, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(28, 30);
  central.writeUInt32LE(0xffffffff, 42);
  const centralExtra = Buffer.alloc(28);
  centralExtra.writeUInt16LE(1, 0);
  centralExtra.writeUInt16LE(24, 2);
  centralExtra.writeBigUInt64LE(2n, 4);
  centralExtra.writeBigUInt64LE(2n, 12);
  const localBytes = Buffer.concat([local, name, localExtra, body]);
  const centralBytes = Buffer.concat([central, name, centralExtra]);
  const end64 = Buffer.alloc(56);
  end64.writeUInt32LE(0x06064b50, 0);
  end64.writeBigUInt64LE(44n, 4);
  end64.writeUInt16LE(45, 12);
  end64.writeUInt16LE(45, 14);
  end64.writeBigUInt64LE(1n, 24);
  end64.writeBigUInt64LE(1n, 32);
  end64.writeBigUInt64LE(BigInt(centralBytes.length), 40);
  end64.writeBigUInt64LE(BigInt(localBytes.length), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(localBytes.length + centralBytes.length), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([localBytes, centralBytes, end64, locator, end]);
}

async function collect(bytes: Uint8Array, overrides = {}) {
  const entries: Array<{ name: string; bytes: Buffer }> = [];
  await readZipArchive(
    chunked(bytes, 31),
    { ...limits, ...overrides },
    async (name, _size, chunks) => {
      const values: Uint8Array[] = [];
      for await (const chunk of chunks) values.push(chunk);
      entries.push({ name, bytes: Buffer.concat(values) });
    },
  );
  return entries;
}

describe("bounded account ZIP reader", () => {
  it.each(["stored", "deflated"])(
    "preserves nested %s ZIPs as opaque home and artifact bytes",
    async (compression) => {
      const nested = buildArchive([
        ["manifest.json", "not the outer manifest"],
        ["spaces/inner/records.jsonl", "inner"],
      ]);
      const files: Array<[string, Uint8Array]> = [
        ["manifest.json", Buffer.from("{}")],
        ["spaces/s1/homes/b1/nested.zip", nested],
        ["spaces/s1/artifacts/a1", nested],
        ["spaces/s1/homes/b1/after.txt", Buffer.from("after")],
      ];
      const bytes = compression === "stored" ? storedArchive(files) : buildArchive(files);
      const received: Buffer[] = [];
      let current: Uint8Array[] = [];
      const sink: ArchiveSink = {
        async open() {
          current = [];
        },
        async write(chunk) {
          current.push(chunk);
        },
        async close() {
          received.push(Buffer.concat(current));
        },
      };
      await readArchive(chunked(bytes, 13), limits, sink);
      expect(received).toEqual(files.map(([, content]) => Buffer.from(content)));
    },
  );

  it("accepts bounded, consistent ZIP64 records", async () => {
    expect(await collect(zip64())).toEqual([{ name: "manifest.json", bytes: Buffer.from("{}") }]);
  });

  it("validates ZIP64 records even when the ordinary end record needs no sentinels", async () => {
    const bytes = zip64();
    const end64 = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]));
    const end = bytes.length - 22;
    bytes.writeUInt16LE(1, end + 8);
    bytes.writeUInt16LE(1, end + 10);
    bytes.writeUInt32LE(Number(bytes.readBigUInt64LE(end64 + 40)), end + 12);
    bytes.writeUInt32LE(Number(bytes.readBigUInt64LE(end64 + 48)), end + 16);
    expect(await collect(bytes)).toEqual([{ name: "manifest.json", bytes: Buffer.from("{}") }]);
    bytes.writeUInt32LE(1, end + 16);
    await expect(collect(bytes)).rejects.toThrow("Invalid ZIP");
  });

  it.each([
    "unsafe-offset",
    "truncated-extra",
    "record-bounds",
    "count-mismatch",
    "local-bounds",
    "missing-locator",
  ])("rejects malformed ZIP64 %s before opening a sink", async (kind) => {
    const bytes = zip64();
    const end64 = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]));
    const locator = end64 + 56;
    if (kind === "unsafe-offset") bytes.writeBigUInt64LE(2n ** 53n, locator + 8);
    if (kind === "truncated-extra") bytes.writeUInt16LE(8, 30 + "manifest.json".length + 2);
    if (kind === "record-bounds") bytes.writeBigUInt64LE(45n, end64 + 4);
    if (kind === "count-mismatch") bytes.writeBigUInt64LE(2n, end64 + 32);
    if (kind === "local-bounds")
      bytes.writeBigUInt64LE(2n ** 52n, 30 + "manifest.json".length + 12);
    if (kind === "missing-locator") bytes.writeUInt32LE(0, locator);
    const consume = vi.fn();
    await expect(readZipArchive(chunked(bytes), limits, consume)).rejects.toThrow("Invalid ZIP");
    expect(consume).not.toHaveBeenCalled();
  });

  it.each(["metadataBytes", "entries", "nameBytes", "bodyBytes"])(
    "bounds %s before opening a sink",
    async (field) => {
      const consume = vi.fn();
      await expect(
        readZipArchive(
          chunked(zip64()),
          { ...limits, [field]: field === "entries" ? 0 : 1 },
          consume,
        ),
      ).rejects.toThrow("exceeds its limit");
      expect(consume).not.toHaveBeenCalled();
    },
  );

  it("rejects inflated data exceeding its advertised size", async () => {
    const bytes = Buffer.from(buildArchive([["manifest.json", "x".repeat(10000)]]));
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const trailer = central - 16;
    bytes.writeUInt32LE(1, central + 24);
    bytes.writeUInt32LE(1, trailer + 12);
    await expect(collect(bytes)).rejects.toThrow("Invalid ZIP");
  });

  it("rejects a checksum mismatch instead of accepting changed file bytes", async () => {
    const bytes = zip64();
    bytes[30 + "manifest.json".length + 20] = 42;
    await expect(collect(bytes)).rejects.toThrow("Invalid ZIP");
  });

  it.each(["before-decompression", "during-decompression"])(
    "cleans up cancellation %s after upload completes",
    async (phase) => {
      const controller = new AbortController();
      const reason = new Error("request cancelled after upload");
      let uploaded = false;
      let output = 0;
      const bytes = buildArchive([["manifest.json", "x".repeat(1024 * 1024)]]);
      async function* body() {
        yield bytes;
        uploaded = true;
      }
      const pending = readZipArchive(
        body(),
        limits,
        async (_name, _size, chunks) => {
          expect(uploaded).toBe(true);
          if (phase === "before-decompression") controller.abort(reason);
          for await (const chunk of chunks) {
            output += chunk.byteLength;
            if (phase === "during-decompression") controller.abort(reason);
          }
        },
        controller.signal,
      );
      await expect(pending).rejects.toBe(reason);
      expect(output).toBeLessThan(1024 * 1024);
      const directory = await vi.mocked(fs.mkdtemp).mock.results.at(-1)!.value;
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("cancels a stalled HTTP upload and removes its spool", async () => {
    const controller = new AbortController();
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        pulls++;
        if (pulls === 1) stream.enqueue(zip64().subarray(0, 10));
      },
      cancel() {
        cancelled = true;
      },
    });
    const app = new Hono();
    mountAccountImportRoute(app, { maxArtifactBytes: 1024 } as AccountImportDeps, async () => ({
      userId: "user-1",
      spaceId: "space-1",
      email: "test@example.test",
      isDeploymentOwner: false,
    }));
    const request = new Request("http://localhost/api/account/import", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body,
      signal: controller.signal,
      duplex: "half",
    } as RequestInit);
    const pending = app.request(request);
    await vi.waitFor(() => expect(pulls).toBeGreaterThan(1));
    controller.abort(new Error("request cancelled"));
    await pending;
    expect(cancelled).toBe(true);
    const directory = await vi.mocked(fs.mkdtemp).mock.results.at(-1)!.value;
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["success", "body-cancellation", "sink-failure", "body-limit", "invalid-directory"])(
    "removes its private spool after %s",
    async (mode) => {
      const mkdtemp = vi.mocked(fs.mkdtemp);
      const bytes = zip64();
      async function* body() {
        yield bytes.subarray(0, 10);
        if (mode === "body-cancellation") throw new Error("request cancelled");
        yield bytes.subarray(10);
      }
      const consume = async (_name: string, _size: number, chunks: AsyncIterable<Uint8Array>) => {
        for await (const _chunk of chunks) {
          if (mode === "sink-failure") throw new Error("sink failed");
        }
      };
      const pending = readZipArchive(
        mode === "invalid-directory" ? chunked(bytes.subarray(0, 10)) : body(),
        { ...limits, ...(mode === "body-limit" ? { bodyBytes: 1 } : {}) },
        consume,
      );
      if (mode === "success") await pending;
      else await expect(pending).rejects.toThrow();
      const result = mkdtemp.mock.results.at(-1)!;
      expect(result.type).toBe("return");
      const directory = await result.value;
      expect(directory).toContain("orkbot-account-archive-");
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
