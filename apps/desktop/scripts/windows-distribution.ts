// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./windows-distribution.ps1", import.meta.url));
const excludedCredentials = [
  "EnvironmentCredential",
  "WorkloadIdentityCredential",
  "ManagedIdentityCredential",
  "SharedTokenCacheCredential",
  "VisualStudioCredential",
  "VisualStudioCodeCredential",
  "AzurePowerShellCredential",
  "AzureDeveloperCliCredential",
  "InteractiveBrowserCredential",
];

type Command = (command: string, args: string[]) => void;
const checked: Command = (command, args) => {
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: 20 * 60_000 });
  } catch {
    throw new Error(`Windows distribution validation failed: ${path.basename(command)}.`);
  }
};

export function windowsSigningConfiguration(env: NodeJS.ProcessEnv, metadata: string) {
  const endpoint = env.WINDOWS_SIGNING_ENDPOINT?.trim();
  const account = env.WINDOWS_SIGNING_ACCOUNT?.trim();
  const profile = env.WINDOWS_SIGNING_PROFILE?.trim();
  const signTool = env.WINDOWS_SIGNTOOL_PATH?.trim();
  const dlib = env.WINDOWS_SIGNING_DLIB_PATH?.trim();
  const record = env.WINDOWS_SIGNING_RECORD_PATH?.trim();
  if (
    !endpoint ||
    !account ||
    !profile ||
    !signTool ||
    !dlib ||
    !record ||
    !path.isAbsolute(record) ||
    existsSync(record) ||
    !path.isAbsolute(metadata)
  )
    throw new Error("Windows release signing configuration is required.");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Invalid Windows signing endpoint.");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".codesigning.azure.net") ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid Windows signing endpoint.");
  if (
    !path.isAbsolute(signTool) ||
    !path.isAbsolute(dlib) ||
    !existsSync(signTool) ||
    !existsSync(dlib) ||
    !statSync(signTool).isFile() ||
    !statSync(dlib).isFile()
  )
    throw new Error("Windows signing tools are unavailable.");
  return {
    metadata: {
      Endpoint: url.origin,
      CodeSigningAccountName: account,
      CertificateProfileName: profile,
      ExcludeCredentials: excludedCredentials,
    },
    overlay: {
      bundle: {
        windows: {
          signCommand: {
            cmd: "powershell.exe",
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              script,
              "-Mode",
              "sign",
              "-Metadata",
              metadata,
              "-Path",
              "%1",
            ],
          },
        },
      },
    },
  };
}

export function prepareWindowsSigning(overlay: string, metadata: string, env: NodeJS.ProcessEnv) {
  const config = windowsSigningConfiguration(env, metadata);
  const record = env.WINDOWS_SIGNING_RECORD_PATH!;
  writeFileSync(record, "", { mode: 0o600, flag: "wx" });
  try {
    writeFileSync(metadata, `${JSON.stringify(config.metadata)}\n`, { mode: 0o600, flag: "wx" });
    try {
      writeFileSync(overlay, `${JSON.stringify(config.overlay)}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) {
      rmSync(metadata, { force: true });
      throw error;
    }
  } catch (error) {
    rmSync(record, { force: true });
    throw error;
  }
}

function filesBelow(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(file) : entry.isFile() ? [file] : [];
  });
}
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

export function verifyWindowsDistribution(
  bundle: string,
  app: string,
  run: Command = checked,
  record = process.env.WINDOWS_SIGNING_RECORD_PATH,
) {
  if (!existsSync(app) || !statSync(app).isFile() || !app.toLowerCase().endsWith(".exe"))
    throw new Error("Expected a Windows application executable.");
  if (!record || !path.isAbsolute(record) || !existsSync(record))
    throw new Error("Windows signing record is unavailable.");
  const records = readFileSync(record, "utf8")
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const appRecords = records.filter(
    (entry) =>
      typeof entry.path === "string" &&
      path.resolve(entry.path).toLowerCase() === path.resolve(app).toLowerCase() &&
      typeof entry.sha256 === "string" &&
      /^[a-f0-9]{64}$/i.test(entry.sha256),
  );
  const expected = appRecords.at(-1)?.sha256.toLowerCase();
  if (!expected) throw new Error("Signed application record is unavailable.");
  const installers = filesBelow(path.join(bundle, "nsis")).filter((file) =>
    file.toLowerCase().endsWith(".exe"),
  );
  if (installers.length !== 1) throw new Error("Expected one Windows installer.");
  const verify = (file: string) =>
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Mode",
      "verify",
      "-Path",
      file,
    ]);
  verify(installers[0]!);
  const temporary = mkdtempSync(path.join(os.tmpdir(), "ork-windows-verification-"));
  try {
    run("7z.exe", ["x", "-y", `-o${temporary}`, installers[0]!]);
    const extracted = filesBelow(temporary).filter(
      (file) => path.basename(file).toLowerCase() === path.basename(app).toLowerCase(),
    );
    if (extracted.length !== 1 || digest(extracted[0]!) !== expected)
      throw new Error("Installer application does not match the signed build.");
    verify(extracted[0]!);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , command, first, second] = process.argv;
  if (!first || !second) throw new Error("Missing Windows release arguments.");
  if (command === "prepare") prepareWindowsSigning(first, second, process.env);
  else if (command === "verify") verifyWindowsDistribution(first, second);
  else throw new Error("Invalid Windows release command.");
}
