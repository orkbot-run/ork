// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { extractMcpResultImages } from "./mcp-result-images.js";

let png: Buffer;
let jpeg: Buffer;
beforeAll(async () => {
  const pixel = { create: { width: 1, height: 1, channels: 3 as const, background: "white" } };
  [png, jpeg] = await Promise.all([sharp(pixel).png().toBuffer(), sharp(pixel).jpeg().toBuffer()]);
});

function block(bytes: Buffer, mimeType = "image/png") {
  return { type: "image", mimeType, data: bytes.toString("base64") };
}

function paddedJpeg(size: number): Buffer {
  const chunks = [jpeg.subarray(0, 2)];
  let remaining = size - jpeg.length;
  while (remaining > 0) {
    const length = Math.min(remaining, 65_537);
    if (length < 4) throw new Error("Padding too small");
    const chunk = Buffer.alloc(length);
    chunk[0] = 0xff;
    chunk[1] = 0xef;
    chunk.writeUInt16BE(length - 2, 2);
    chunks.push(chunk);
    remaining -= length;
  }
  chunks.push(jpeg.subarray(2));
  return Buffer.concat(chunks);
}

describe("extractMcpResultImages", () => {
  it("extracts PNG/JPEG by bytes, preserves envelope and other blocks, and does not mutate input", () => {
    const text = { type: "text", text: "screenshot" };
    const resource = { type: "resource", resource: { uri: "local:test" } };
    const original = {
      isError: false,
      _meta: { source: "camera" },
      content: [
        text,
        { ...block(png, "image/jpeg"), annotations: { secret: "stripped" } },
        resource,
        block(jpeg, "image/png"),
      ],
    };
    const snapshot = structuredClone(original);
    const extracted = extractMcpResultImages(original);
    expect(extracted?.images).toEqual([
      { type: "image", mimeType: "image/png", data: png.toString("base64") },
      { type: "image", mimeType: "image/jpeg", data: jpeg.toString("base64") },
    ]);
    expect(extracted?.result).toEqual({
      ...original,
      content: [
        text,
        { type: "text", text: "[MCP image 1: attached as image 1]" },
        resource,
        { type: "text", text: "[MCP image 2: attached as image 2]" },
      ],
    });
    expect(original).toEqual(snapshot);
  });

  it.each([
    undefined,
    null,
    [],
    "text",
    { content: "invalid" },
    { content: [{ type: "text", text: "ok" }] },
    { nested: { content: [{ type: "image", data: "abc" }] } },
    { content: [{ type: "resource", resource: { type: "image", data: "abc" } }] },
  ])("leaves results without direct image blocks to the caller: %j", (result) => {
    expect(extractMcpResultImages(result)).toBeUndefined();
  });

  it("omits malformed, noncanonical, truncated, missing and remote data with bounded text", async () => {
    const gif = await sharp(png).gif().toBuffer();
    const bad = [
      { type: "image" },
      { type: "image", url: "https://example.com/a.png" },
      { type: "image", data: "!!!!" },
      { type: "image", data: "Zh==" },
      { type: "image", data: ` ${png.toString("base64")} ` },
      { type: "image", data: png.toString("base64").slice(0, -1) },
      block(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      block(png.subarray(0, -1)),
      block(jpeg.subarray(0, -1)),
      block(Buffer.from([255, 216, 255, 217])),
      block(gif),
    ];
    const extracted = extractMcpResultImages({ content: bad });
    expect(extracted?.images).toEqual([]);
    const result = extracted?.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toHaveLength(bad.length);
    for (const marker of result.content) {
      expect(marker.type).toBe("text");
      expect(marker.text).toMatch(/omitted/);
      expect(marker.text.length).toBeLessThan(100);
      expect(Object.keys(marker)).toEqual(["type", "text"]);
    }
  });

  it("caps accepted image count at four and does not count invalid blocks", () => {
    const extracted = extractMcpResultImages({
      content: [{ type: "image", data: "bad" }, ...Array.from({ length: 5 }, () => block(png))],
    });
    expect(extracted?.images).toHaveLength(4);
    expect(JSON.stringify(extracted?.result)).toContain("image count limit");
  });

  it("omits PNG images with corrupted chunk data", () => {
    const corrupt = Buffer.from(png);
    const idat = corrupt.indexOf("IDAT");
    corrupt.writeUInt8(corrupt.readUInt8(idat + 4) ^ 1, idat + 4);
    const extracted = extractMcpResultImages({ content: [block(corrupt)] });
    expect(extracted?.images).toEqual([]);
    expect(JSON.stringify(extracted?.result)).toContain("omitted");
  });

  it("rejects noncanonical pad bits and missing padding even when they decode to a valid JPEG", () => {
    const size = jpeg.length + 4 + ((1 - ((jpeg.length + 4) % 3) + 3) % 3);
    const encoded = paddedJpeg(size).toString("base64");
    expect(encoded.endsWith("==")).toBe(true);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const index = alphabet.indexOf(encoded[encoded.length - 3] ?? "");
    const noncanonical = `${encoded.slice(0, -3)}${alphabet[index + 1]}==`;
    expect(Buffer.from(noncanonical, "base64")).toEqual(Buffer.from(encoded, "base64"));
    const extracted = extractMcpResultImages({
      content: [
        { type: "image", data: noncanonical },
        { type: "image", data: encoded.slice(0, -2) },
        { type: "image", data: encoded },
      ],
    });
    expect(extracted?.images).toEqual([{ type: "image", mimeType: "image/jpeg", data: encoded }]);
  });

  it("rejects individually oversized data before decoding", () => {
    const extracted = extractMcpResultImages({
      content: [{ type: "image", data: "A".repeat(Math.ceil((4 * 1024 * 1024 + 1) / 3) * 4) }],
    });
    expect(extracted?.images).toEqual([]);
    expect(JSON.stringify(extracted?.result)).toContain("size limit");
  });

  it("enforces the 4 MiB aggregate decoded cap, including exact boundary", () => {
    const half = paddedJpeg(2 * 1024 * 1024);
    const extracted = extractMcpResultImages({ content: [block(half), block(half), block(png)] });
    expect(extracted?.images).toHaveLength(2);
    expect(
      extracted?.images.reduce((sum, item) => sum + Buffer.byteLength(item.data, "base64"), 0),
    ).toBe(4 * 1024 * 1024);
    expect(JSON.stringify(extracted?.result)).toContain("size limit");
  });

  it("continues with smaller images when a previous image exceeds the remaining budget", () => {
    const big = paddedJpeg(3 * 1024 * 1024);
    const extracted = extractMcpResultImages({ content: [block(big), block(big), block(png)] });
    expect(extracted?.images).toHaveLength(2);
    expect(extracted?.images[1]?.data).toBe(png.toString("base64"));
  });
});
