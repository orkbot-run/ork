// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preparePersonalProfile } from "./macos-personal-profile.ts";

export const APPLE_RELEASE_SECRETS = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY",
  "APPLE_API_PRIVATE_KEY",
] as const;

export function validateAppleSigning(env: NodeJS.ProcessEnv) {
  const missing = APPLE_RELEASE_SECRETS.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing macOS release secrets: ${missing.join(", ")}`);
  if (
    !/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(env.APPLE_SIGNING_IDENTITY!) ||
    !/^[A-Z0-9]{10}$/.test(env.APPLE_API_KEY!) ||
    !/^[a-f0-9-]{36}$/i.test(env.APPLE_API_ISSUER!)
  )
    throw new Error("Invalid macOS distribution signing configuration.");
  try {
    const key = createPrivateKey(env.APPLE_API_PRIVATE_KEY!);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
      throw new Error();
  } catch {
    throw new Error("Invalid Apple notarization private key.");
  }
}

type Command = (command: string, args: string[]) => string;
const checked: Command = (command, args) => {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 20 * 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Signing tool diagnostics can include private identities and account metadata.
    throw new Error(`macOS distribution validation failed: ${path.basename(command)}.`);
  }
};

export function verifyMacApp(app: string, run: Command = checked) {
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  run("/usr/bin/xcrun", ["stapler", "validate", app]);
  run("/usr/sbin/spctl", ["--assess", "--type", "execute", app]);
  verifyMacPersonalKey(app, run);
}

export function verifyMacPersonalKey(app: string, run: Command = checked) {
  run("/bin/test", ["-f", path.join(app, "Contents/embedded.provisionprofile")]);
  const executable = run("/usr/bin/plutil", [
    "-extract",
    "CFBundleExecutable",
    "raw",
    "-o",
    "-",
    path.join(app, "Contents/Info.plist"),
  ]).trim();
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(executable))
    throw new Error("Invalid macOS application executable.");
  run(path.join(app, "Contents/MacOS", executable), ["--personal-device-key-check"]);
}

/** Validate the shipped updater archive as well as the installer, before publishing either. */
export function verifyMacDistribution(
  bundle: string,
  env: NodeJS.ProcessEnv,
  run: Command = checked,
) {
  validateAppleSigning(env);
  if (!env.APPLE_API_KEY_PATH) throw new Error("Missing Apple notarization key path.");
  const macos = path.join(bundle, "macos");
  const apps = readdirSync(macos).filter((name) => name.endsWith(".app"));
  const archives = readdirSync(macos).filter((name) => name.endsWith(".app.tar.gz"));
  const dmgs = readdirSync(path.join(bundle, "dmg")).filter((name) => name.endsWith(".dmg"));
  if (apps.length !== 1 || archives.length !== 1 || dmgs.length !== 1)
    throw new Error("Expected one macOS application, update archive and installer.");
  verifyMacApp(path.join(macos, apps[0]!), run);
  const temporary = mkdtempSync(path.join(os.tmpdir(), "ork-macos-verification-"));
  try {
    run("/usr/bin/tar", ["-xzf", path.join(macos, archives[0]!), "-C", temporary]);
    verifyMacApp(path.join(temporary, apps[0]!), run);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const dmg = path.join(bundle, "dmg", dmgs[0]!);
  const submission = JSON.parse(
    run("/usr/bin/xcrun", [
      "notarytool",
      "submit",
      dmg,
      "--key",
      env.APPLE_API_KEY_PATH!,
      "--key-id",
      env.APPLE_API_KEY!,
      "--issuer",
      env.APPLE_API_ISSUER!,
      "--wait",
      "--output-format",
      "json",
    ]),
  );
  if (submission.status !== "Accepted")
    throw new Error("Apple did not accept the macOS installer.");
  run("/usr/bin/xcrun", ["stapler", "staple", dmg]);
  run("/usr/bin/xcrun", ["stapler", "validate", dmg]);
  run("/usr/sbin/spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    dmg,
  ]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, file] = process.argv.slice(2);
  if (!file) throw new Error("Missing macOS release path.");
  if (command === "prepare") {
    validateAppleSigning(process.env);
    writeFileSync(file, process.env.APPLE_API_PRIVATE_KEY!, { mode: 0o600, flag: "wx" });
  } else if (command === "identity") {
    validateAppleSigning(process.env);
    const config = JSON.parse(readFileSync(file, "utf8"));
    const identity = await preparePersonalProfile(`${file}.identity`, process.env, checked);
    config.bundle ??= {};
    config.bundle.macOS = {
      ...config.bundle.macOS,
      ...identity,
      files: { ...config.bundle.macOS?.files, ...identity.files },
    };
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  } else if (command === "keychain") {
    verifyMacPersonalKey(file);
  } else if (command === "verify") {
    verifyMacDistribution(file, process.env);
  } else throw new Error("Invalid macOS release command.");
}
