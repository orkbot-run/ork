// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

const downloadedType = Symbol("downloaded attachment MIME");

/** Chat SDK accepts Buffer results but has no result-local content-type field. */
export function withAttachmentMimeType(bytes: Buffer, mimeType: string): Buffer {
  Object.defineProperty(bytes, downloadedType, { value: mimeType });
  return bytes;
}

export function attachmentDownload(data: Buffer | ArrayBuffer) {
  const bytes = new Uint8Array(data);
  return downloadedType in data && typeof data[downloadedType] === "string"
    ? { bytes, mimeType: data[downloadedType] }
    : bytes;
}
