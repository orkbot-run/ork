// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInstallationTlsIdentity, installationTlsName } from "./installation-tls.js";

describe("installation TLS identity", () => {
  it("renews certificates without changing the enrolled installation key", async () => {
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = keys.publicKey.export({ format: "der", type: "spki" });
    const fingerprint = createHash("sha256").update(spki).digest("hex");
    const first = await createInstallationTlsIdentity(keys.privateKey, fingerprint);
    const second = await createInstallationTlsIdentity(keys.privateKey, fingerprint);
    expect(second.certificate).not.toBe(first.certificate);
    for (const identity of [first, second]) {
      const cert = new X509Certificate(Buffer.from(identity.certificate, "base64"));
      expect(cert.ca).toBe(false);
      expect(cert.verify(keys.publicKey)).toBe(true);
      expect(cert.publicKey.export({ format: "der", type: "spki" })).toEqual(spki);
      expect(cert.checkHost(installationTlsName(fingerprint))).toBe(
        installationTlsName(fingerprint),
      );
      expect(cert.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
      expect(cert.validFromDate.getTime()).toBeLessThan(Date.now());
      expect(cert.validToDate.getTime()).toBeGreaterThan(Date.now() + 3 * 86_400_000);
      expect(Object.keys(identity).sort()).toEqual(["certificate", "context"]);
    }
  });

  it("refuses malformed fingerprints, wrong keys and unsupported algorithms", async () => {
    for (const fingerprint of ["A".repeat(64), "../other", "a".repeat(63)]) {
      expect(() => installationTlsName(fingerprint)).toThrow();
    }
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    await expect(createInstallationTlsIdentity(keys.privateKey, "0".repeat(64))).rejects.toThrow(
      "mismatch",
    );
    await expect(createInstallationTlsIdentity(keys.publicKey, "0".repeat(64))).rejects.toThrow(
      "Invalid",
    );
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expect(createInstallationTlsIdentity(rsa.privateKey, "0".repeat(64))).rejects.toThrow(
      "Invalid",
    );
  });
});
