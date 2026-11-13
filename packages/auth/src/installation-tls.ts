// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { KeyObject } from "node:crypto";
import { constants, createHash, createPublicKey, webcrypto } from "node:crypto";
import { createSecureContext } from "node:tls";

export function installationTlsName(fingerprint: string): string {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error("Invalid installation fingerprint");
  return `${fingerprint.slice(0, 32)}.${fingerprint.slice(32)}.installation.ork.invalid`;
}

/** The certificate is public; the private key stays inside the server TLS context. */
export async function createInstallationTlsIdentity(key: KeyObject, fingerprint: string) {
  const name = installationTlsName(fingerprint);
  if (
    key.type !== "private" ||
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  )
    throw new Error("Invalid installation TLS key");
  const publicKey = createPublicKey(key).export({ format: "der", type: "spki" });
  if (createHash("sha256").update(publicKey).digest("hex") !== fingerprint)
    throw new Error("Installation TLS key mismatch");
  await import("reflect-metadata");
  // Match authentication's X.509 version; mixed major versions share an algorithm registry.
  const {
    BasicConstraintsExtension,
    ExtendedKeyUsageExtension,
    KeyUsageFlags,
    KeyUsagesExtension,
    SubjectAlternativeNameExtension,
    X509CertificateGenerator,
  } = await import("@peculiar/x509");
  const crypto = webcrypto as unknown as NonNullable<
    Parameters<typeof X509CertificateGenerator.createSelfSigned>[1]
  >;
  const algorithm = { name: "ECDSA", namedCurve: "P-256" };
  const keys = {
    publicKey: await crypto.subtle.importKey("spki", publicKey, algorithm, true, ["verify"]),
    privateKey: await crypto.subtle.importKey(
      "pkcs8",
      key.export({ format: "der", type: "pkcs8" }),
      algorithm,
      false,
      ["sign"],
    ),
  };
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      name: `CN=${name}`,
      keys,
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      notBefore: new Date(Date.now() - 5 * 60_000),
      notAfter: new Date(Date.now() + 4 * 86_400_000),
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
        new SubjectAlternativeNameExtension([{ type: "dns", value: name }]),
      ],
    },
    crypto,
  );
  return {
    certificate: Buffer.from(certificate.rawData).toString("base64"),
    context: createSecureContext({
      cert: certificate.toString("pem"),
      key: key.export({ type: "pkcs8", format: "pem" }),
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      secureOptions: constants.SSL_OP_NO_TICKET,
    }),
  };
}
