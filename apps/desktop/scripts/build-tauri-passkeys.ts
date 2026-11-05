// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PASSKEY_RP_ID, passkeyEntitlements } from "../src/passkeys.js";

type Profile = {
  team: unknown;
  expires: unknown;
  entitlements: Record<string, unknown>;
};

/** Validate the profile before giving its identity and domain to the main app. */
export function validatePasskeyProfile(
  profile: Profile,
  bundleId: string,
  rpId: string,
  developerMode: boolean,
  now = Date.now(),
): string {
  const team = Array.isArray(profile.team) ? profile.team[0] : undefined;
  if (typeof team !== "string" || !/^[A-Z0-9]{10}$/.test(team))
    throw new Error("The passkey profile has no valid team identifier.");
  if (
    typeof profile.expires !== "string" ||
    !Number.isFinite(Date.parse(profile.expires)) ||
    Date.parse(profile.expires) <= now
  )
    throw new Error("The passkey profile has expired or has no expiration date.");
  const entitlements = profile.entitlements;
  if (!entitlements || typeof entitlements !== "object")
    throw new Error("The passkey profile has no entitlements.");
  if (entitlements["com.apple.application-identifier"] !== `${team}.${bundleId}`)
    throw new Error("The passkey profile is not for the Preview app identifier.");
  const domains = entitlements["com.apple.developer.associated-domains"];
  const domain = `webcredentials:${rpId}${developerMode ? "?mode=developer" : ""}`;
  if (!Array.isArray(domains) || !domains.some((value) => value === "*" || value === domain))
    throw new Error("The passkey profile does not authorize the relying party domain.");
  if (developerMode && entitlements["com.apple.security.get-task-allow"] !== true)
    throw new Error("Passkey developer mode requires a development provisioning profile.");
  return team;
}

/** Keep the profile in Contents and keep helper signing on the base entitlements. */
export function passkeyBundleConfig(entitlements: string, profile: string, helper: string) {
  return {
    build: { beforeBuildCommand: "" },
    bundle: {
      externalBin: [],
      macOS: {
        entitlements,
        files: { "embedded.provisionprofile": profile, "MacOS/orkbot-speech": helper },
      },
    },
  };
}

function checkedOutput(command: string, args: string[], input?: string, timeout = 10_000): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error("Could not read passkey signing metadata.");
  return result.stdout;
}

export function buildTauri(args: string[]) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const profile = process.env.PASSKEY_PROFILE?.trim();
  const extra: string[] = [];
  if (profile) {
    if (process.platform !== "darwin") throw new Error("Passkey profiles require a macOS build.");
    const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
    if (!identity || identity === "-" || args.includes("--no-sign"))
      throw new Error("A passkey build requires an Apple signing identity.");
    const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
    const decoded = checkedOutput("/usr/bin/security", ["cms", "-D", "-i", path.resolve(profile)]);
    const extract = (key: string, format: string) =>
      checkedOutput("/usr/bin/plutil", ["-extract", key, format, "-o", "-", "-"], decoded).trim();
    const developerMode = process.env.ORKBOT_PASSKEY_DEVELOPER_MODE === "1";
    const team = validatePasskeyProfile(
      {
        team: JSON.parse(extract("TeamIdentifier", "json")),
        expires: extract("ExpirationDate", "raw"),
        entitlements: JSON.parse(extract("Entitlements", "json")),
      },
      config.identifier,
      PASSKEY_RP_ID,
      developerMode,
    );
    const base = readFileSync(path.join(root, "src-tauri/Entitlements.plist"), "utf8");
    const entitlements = passkeyEntitlements(base, team, config.identifier, { developerMode });
    // Prepare first, then sign a separate copy. Tauri otherwise gives every sidecar the app's entitlements.
    checkedOutput(
      process.execPath,
      [path.join(root, "scripts/prepare-tauri.mjs")],
      undefined,
      120_000,
    );
    const output = path.join(root, "build/tauri-passkeys");
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const entitlementPath = path.join(output, "Entitlements.plist");
    const profilePath = path.join(output, "embedded.provisionprofile");
    const helperPath = path.join(output, "orkbot-speech");
    writeFileSync(entitlementPath, entitlements, { mode: 0o600 });
    copyFileSync(path.resolve(profile), profilePath);
    copyFileSync(path.join(root, "build/tauri-native/orkbot-speech"), helperPath);
    checkedOutput(
      "/usr/bin/codesign",
      [
        "--force",
        "--sign",
        identity,
        "--options",
        "runtime",
        "--timestamp",
        "--entitlements",
        path.join(root, "src-tauri/Entitlements.plist"),
        helperPath,
      ],
      undefined,
      120_000,
    );
    checkedOutput("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--test-requirement",
      `=anchor apple generic and certificate leaf[subject.OU] = "${team}"`,
      helperPath,
    ]);
    // Pass an overlay only for this invocation. Default builds never load stale signing files.
    extra.push(
      "--config",
      JSON.stringify(passkeyBundleConfig(entitlementPath, profilePath, helperPath)),
    );
  }
  const entry = process.env.npm_execpath;
  const useEntry = entry && path.isAbsolute(entry);
  const result = spawnSync(
    useEntry ? process.execPath : "pnpm",
    [...(useEntry ? [entry] : []), "exec", "tauri", "build", ...args, ...extra],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  if (result.error || result.status !== 0) throw new Error("The Tauri build failed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildTauri(process.argv.slice(2));
}
