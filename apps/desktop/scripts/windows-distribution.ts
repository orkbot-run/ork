// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Restrict the credential chain to the Azure CLI session established by the operator.
// In GitHub Actions, azure/login can establish this session with federated OIDC.
export function windowsSigningConfiguration(options: {
  signtool: string;
  dlib: string;
  metadata: string;
}) {
  if (
    ![options.signtool, options.dlib, options.metadata].every((value) =>
      value.trim(),
    )
  )
    throw new Error(
      "SignTool, Artifact Signing Dlib and metadata paths are required.",
    );

  return {
    bundle: {
      windows: {
        signCommand: {
          cmd: options.signtool,
          args: [
            "sign",
            "/fd",
            "SHA256",
            "/tr",
            "http://timestamp.acs.microsoft.com",
            "/td",
            "SHA256",
            "/dlib",
            options.dlib,
            "/dmdf",
            options.metadata,
            "%1",
          ],
        },
      },
    },
  };
}

export function artifactSigningMetadata() {
  return {
    Endpoint: "https://plc.codesigning.azure.net/",
    CodeSigningAccountName: "orkbot-signing",
    CertificateProfileName: "ork-windows",
    ExcludeCredentials: [
      "EnvironmentCredential",
      "WorkloadIdentityCredential",
      "ManagedIdentityCredential",
      "SharedTokenCacheCredential",
      "VisualStudioCredential",
      "VisualStudioCodeCredential",
      "AzurePowerShellCredential",
      "AzureDeveloperCliCredential",
      "InteractiveBrowserCredential",
    ],
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, configFile, metadataFile] = process.argv.slice(2);
  if (
    process.platform !== "win32" ||
    command !== "prepare" ||
    !configFile ||
    !metadataFile
  )
    throw new Error(
      "Expected: prepare <config path> <metadata path> on Windows.",
    );
  const metadata = path.resolve(metadataFile);
  const config = windowsSigningConfiguration({
    signtool: process.env.ORK_WINDOWS_SIGNTOOL ?? "",
    dlib: process.env.ORK_WINDOWS_SIGNING_DLIB ?? "",
    metadata,
  });
  writeFileSync(metadata, JSON.stringify(artifactSigningMetadata()), {
    flag: "wx",
  });
  writeFileSync(configFile, JSON.stringify(config), { flag: "wx" });
}
