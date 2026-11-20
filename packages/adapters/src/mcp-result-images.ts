// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { crc32 } from "node:zlib";
import type { AgentToolExecutionResult } from "@orkbot/adapter-kit";
import { decodeAttachmentBase64 } from "@orkbot/core";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 4;

type McpImage = { type: "image"; mimeType: "image/png" | "image/jpeg"; data: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Check framing without decompressing untrusted pixels or allocating an image bitmap. */
function imageMime(bytes: Buffer): McpImage["mimeType"] | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8;
    let hasData = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > bytes.length) return;
      if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return;
      const kind = bytes.toString("ascii", offset + 4, offset + 8);
      if (offset === 8) {
        if (kind !== "IHDR" || length !== 13) return;
        if (bytes.readUInt32BE(offset + 8) === 0 || bytes.readUInt32BE(offset + 12) === 0) return;
      } else if (kind === "IHDR") return;
      if (kind === "IDAT" && length > 0) hasData = true;
      if (kind === "IEND") {
        return length === 0 && end === bytes.length && hasData ? "image/png" : undefined;
      }
      offset = end;
    }
    return;
  }

  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  let offset = 2;
  let hasFrame = false;
  let hasScan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined) return;
    if (marker === 0xd9) {
      return hasFrame && hasScan && offset === bytes.length ? "image/jpeg" : undefined;
    }
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return;
    if (offset + 2 > bytes.length) return;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (
        length < 8 ||
        bytes.readUInt16BE(offset + 3) === 0 ||
        bytes.readUInt16BE(offset + 5) === 0
      )
        return;
      hasFrame = true;
    }
    offset += length;
    if (marker === 0xda) {
      if (!hasFrame || length < 6) return;
      hasScan = true;
      // Skip entropy-coded bytes, escaped FF bytes and restart markers. Another
      // real marker returns to the outer loop (including progressive scans).
      const scanStart = offset;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          continue;
        }
        let next = offset + 1;
        while (bytes[next] === 0xff) next++;
        const code = bytes[next];
        if (code === 0 || (code !== undefined && code >= 0xd0 && code <= 0xd7)) {
          offset = next + 1;
        } else break;
      }
      if (offset === scanStart) return;
    }
  }
  return;
}

/** Extract only direct MCP content images; never follow URLs or inspect nested tool data. */
export function extractMcpResultImages(
  result: unknown,
): { result: Record<string, unknown>; images: McpImage[] } | undefined {
  if (!record(result) || !Array.isArray(result.content)) return;
  if (!result.content.some((block) => record(block) && block.type === "image")) return;

  const images: McpImage[] = [];
  let totalBytes = 0;
  let imageNumber = 0;
  const content = result.content.map((block: unknown) => {
    if (!record(block) || block.type !== "image") return block;
    imageNumber++;
    let note = "omitted: invalid or unsupported PNG/JPEG image";
    if (images.length >= MAX_IMAGES) note = "omitted: image count limit reached";
    else if (typeof block.data === "string") {
      const remaining = MAX_IMAGE_BYTES - totalBytes;
      const padding = block.data.endsWith("==") ? 2 : block.data.endsWith("=") ? 1 : 0;
      const decodedLength = Math.floor(block.data.length / 4) * 3 - padding;
      if (decodedLength > remaining || block.data.length > Math.ceil(remaining / 3) * 4) {
        note = "omitted: aggregate image size limit reached (4 MiB)";
      } else {
        try {
          const decoded = decodeAttachmentBase64(block.data, remaining);
          const bytes = Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength);
          // The shared decoder tolerates surrounding whitespace and unused pad
          // bits; MCP image transport requires an exact canonical encoding.
          const canonical = bytes.toString("base64");
          const mimeType = canonical === block.data ? imageMime(bytes) : undefined;
          if (mimeType) {
            images.push({ type: "image", mimeType, data: canonical });
            totalBytes += bytes.length;
            note = `attached as image ${images.length}`;
          }
        } catch {
          // Never echo untrusted binary content or metadata into the text result.
        }
      }
    }
    return { type: "text", text: `[MCP image ${imageNumber}: ${note}]` };
  });
  return { result: { ...result, content }, images };
}

/** Keep the binary parts outside the result metadata persisted with approved effects. */
export function prepareMcpImageResult(
  result: unknown,
  limitText?: (value: Record<string, unknown>) => Record<string, unknown>,
): AgentToolExecutionResult | undefined {
  const extracted = extractMcpResultImages(result);
  if (!extracted) return;
  const textResult = limitText ? limitText(extracted.result) : extracted.result;
  return {
    kind: "agent_tool_result",
    content: extracted.images,
    details: {
      ...textResult,
      ...(extracted.result.isError === true ? { isError: true } : {}),
      orkbotMcpImages: true,
    },
  };
}

export function isMcpImageResultDetails(
  value: unknown,
): value is Record<string, unknown> & { orkbotMcpImages: true } {
  return record(value) && value.orkbotMcpImages === true;
}
