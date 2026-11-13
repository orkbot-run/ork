// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type Command = (command: string, args: string[]) => string;

const paths = (output: string): string[] => {
  try {
    const pattern = /"((?:[^"\\]|\\.)*)"/g;
    if (output.replace(pattern, "").trim()) throw new Error();
    return [...output.matchAll(pattern)].map((match) => JSON.parse(match[0]!) as string);
  } catch {
    throw new Error("Could not read the macOS keychain list.");
  }
};

/** Own one temporary signing keychain, while preserving unrelated keychains and later changes. */
export function signingKeychain(env: NodeJS.ProcessEnv, run: Command): (() => void) | undefined {
  if (!env.APPLE_CERTIFICATE) return undefined;
  if (!env.APPLE_CERTIFICATE_PASSWORD) throw new Error("Missing Apple certificate password.");
  // Validate the list before creating anything; read it again when attaching the keychain.
  paths(run("/usr/bin/security", ["list-keychains", "-d", "user"]));
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ork-signing-identity-")));
  const file = path.join(directory, "signing.keychain-db");
  const certificate = path.join(directory, "identity.p12");
  const password = randomBytes(32).toString("base64url");
  let created = false;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (created) {
        try {
          const current = paths(run("/usr/bin/security", ["list-keychains", "-d", "user"]));
          run("/usr/bin/security", [
            "list-keychains",
            "-d",
            "user",
            "-s",
            ...current.filter((value) => value !== file),
          ]);
        } finally {
          run("/usr/bin/security", ["delete-keychain", file]);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  try {
    writeFileSync(certificate, Buffer.from(env.APPLE_CERTIFICATE, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
    run("/usr/bin/security", ["create-keychain", "-p", password, file]);
    created = true;
    run("/usr/bin/security", ["set-keychain-settings", "-lut", "21600", file]);
    run("/usr/bin/security", ["unlock-keychain", "-p", password, file]);
    run("/usr/bin/security", [
      "import",
      certificate,
      "-k",
      file,
      "-P",
      env.APPLE_CERTIFICATE_PASSWORD,
      "-T",
      "/usr/bin/codesign",
    ]);
    run("/usr/bin/security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      password,
      file,
    ]);
    const current = paths(run("/usr/bin/security", ["list-keychains", "-d", "user"]));
    run("/usr/bin/security", [
      "list-keychains",
      "-d",
      "user",
      "-s",
      file,
      ...current.filter((value) => value !== file),
    ]);
    rmSync(certificate, { force: true });
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function configuredPersonalIdentity(
  args: string[],
  root: string,
): { profile: string; entitlements: string } | undefined {
  let entitlements: unknown;
  let files: Record<string, unknown> = {};
  // Configuration files are trusted build inputs, never renderer input.
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    const input =
      argument === "--config" || argument === "-c"
        ? args[++index]
        : argument.startsWith("--config=")
          ? argument.slice(9)
          : undefined;
    if (!input) continue;
    const config = JSON.parse(input.startsWith("{") ? input : readConfig(input, root));
    if (config.bundle?.macOS?.entitlements !== undefined)
      entitlements = config.bundle.macOS.entitlements;
    files = { ...files, ...config.bundle?.macOS?.files };
  }
  const profile = files["embedded.provisionprofile"];
  if (profile === undefined) return undefined;
  if (typeof profile !== "string" || typeof entitlements !== "string")
    throw new Error("Incomplete macOS keychain signing configuration.");
  const resolve = (value: string) =>
    path.isAbsolute(value) ? value : path.resolve(root, "src-tauri", value);
  return { profile: resolve(profile), entitlements: resolve(entitlements) };
}

function readConfig(file: string, root: string): string {
  // Loaded lazily so importing the signing helper does not read a build configuration.
  return readFileSync(path.resolve(root, file), "utf8");
}
