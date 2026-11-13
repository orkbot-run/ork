// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createPublicKey, verify } from "node:crypto";

export function personalDeviceKey(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    const key = createPublicKey({ key: bytes, type: "spki", format: "der" });
    return bytes.toString("base64url") === value &&
      key.asymmetricKeyType === "ec" &&
      key.asymmetricKeyDetails?.namedCurve === "prime256v1" &&
      key.export({ type: "spki", format: "der" }).equals(bytes)
      ? value
      : null;
  } catch {
    return null;
  }
}
export function personalDeviceSignature(
  publicKey: string,
  message: string,
  signature: unknown,
): boolean {
  if (
    typeof signature !== "string" ||
    !/^[A-Za-z0-9_-]{80,110}$/.test(signature) ||
    !personalDeviceKey(publicKey)
  )
    return false;
  try {
    const bytes = Buffer.from(signature, "base64url");
    return (
      bytes.toString("base64url") === signature &&
      verify(
        "sha256",
        Buffer.from(message),
        { key: Buffer.from(publicKey, "base64url"), type: "spki", format: "der" },
        bytes,
      )
    );
  } catch {
    return false;
  }
}
