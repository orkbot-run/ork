// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it } from "vitest";
import { attachmentDownload, withAttachmentMimeType } from "./chat-sdk-attachment.js";

it("keeps metadata local to overlapping downloads of one attachment", async () => {
  let first!: (value: Buffer) => void;
  let second!: (value: Buffer) => void;
  const fetches = [
    new Promise<Buffer>((resolve) => {
      first = resolve;
    }),
    new Promise<Buffer>((resolve) => {
      second = resolve;
    }),
  ];
  const results = fetches.map(async (fetch) => attachmentDownload(await fetch));
  const png = Buffer.from([1]);
  expect(withAttachmentMimeType(png, "image/png")).toBe(png);
  second(withAttachmentMimeType(Buffer.from([2]), "image/jpeg"));
  first(png);
  expect(await Promise.all(results)).toEqual([
    { bytes: new Uint8Array([1]), mimeType: "image/png" },
    { bytes: new Uint8Array([2]), mimeType: "image/jpeg" },
  ]);
});

it("preserves byte-only results and ignores unbranded external metadata", () => {
  expect(attachmentDownload(Buffer.from([1]))).toEqual(new Uint8Array([1]));
  expect(attachmentDownload(new Uint8Array([2]).buffer)).toEqual(new Uint8Array([2]));
  expect(attachmentDownload(Object.assign(Buffer.from([3]), { mimeType: "image/png" }))).toEqual(
    new Uint8Array([3]),
  );
});
