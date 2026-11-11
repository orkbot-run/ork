// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it } from "vitest";
import {
  artifactSigningMetadata,
  windowsSigningConfiguration,
} from "../scripts/windows-distribution.js";

it("configures Tauri to sign each binary with a timestamp using the selected Azure CLI identity", () => {
  const metadata = artifactSigningMetadata();
  expect(metadata.Endpoint).toBe("https://plc.codesigning.azure.net/");
  expect(metadata.CertificateProfileName).toBe("ork-windows");
  expect(metadata.ExcludeCredentials).not.toContain("AzureCliCredential");
  expect(metadata.ExcludeCredentials).toContain("EnvironmentCredential");
  const config = windowsSigningConfiguration({
    signtool: "C:\\SDK Tools\\signtool.exe",
    dlib: "C:\\Signing Tools\\Azure.CodeSigning.Dlib.dll",
    metadata: "C:\\Temp Files\\metadata.json",
  });
  expect(config.bundle.windows.signCommand.args).toEqual([
    "sign",
    "/fd",
    "SHA256",
    "/tr",
    "http://timestamp.acs.microsoft.com",
    "/td",
    "SHA256",
    "/dlib",
    "C:\\Signing Tools\\Azure.CodeSigning.Dlib.dll",
    "/dmdf",
    "C:\\Temp Files\\metadata.json",
    "%1",
  ]);
  expect(() => windowsSigningConfiguration({ signtool: "", dlib: "x", metadata: "y" })).toThrow();
});
