// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { personalDeviceKey, personalDeviceSignature } from "./personal-device-key.js";

it("accepts an exact P-256 SPKI signature and rejects other keys, messages and encodings", () => {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = key.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const message = "device-bound activation fixture";
  const signature = sign("sha256", Buffer.from(message), key.privateKey).toString("base64url");
  expect(personalDeviceKey(publicKey)).toBe(publicKey);
  expect(personalDeviceSignature(publicKey, message, signature)).toBe(true);
  expect(personalDeviceSignature(publicKey, "another installation", signature)).toBe(false);
  expect(personalDeviceSignature(publicKey, message, `${signature}=`)).toBe(false);
  for (const curve of ["secp384r1", "secp521r1"])
    expect(
      personalDeviceKey(
        generateKeyPairSync("ec", { namedCurve: curve })
          .publicKey.export({ type: "spki", format: "der" })
          .toString("base64url"),
      ),
    ).toBeNull();
  expect(personalDeviceKey(`${publicKey}=`)).toBeNull();
});
