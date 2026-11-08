// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: This CI script is not a Turbo task.
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// These assets and hashes correspond to the pinned Tauri CLI 2.12.4 toolchain.
const assets = {
  apprun: [
    "tauri-apps/binary-releases",
    "274691722",
    "f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f",
  ],
  linuxdeploy: [
    "tauri-apps/binary-releases",
    "576945544",
    "36a2d7e274d12e1050d0e9ecfe11d339ed54720b2bec464c286d53f8b07f5c62",
  ],
  nsis: [
    "tauri-apps/binary-releases",
    "623832696",
    "ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8",
  ],
  plugin: [
    "tauri-apps/nsis-tauri-utils",
    "345882097",
    "5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709",
  ],
};

export function verifySha256(bytes, expected) {
  return (
    /^[a-f0-9]{64}$/.test(expected) && createHash("sha256").update(bytes).digest("hex") === expected
  );
}

export function tauriCache(platform, env) {
  if (platform === "Linux")
    return path.join(
      env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME)
        ? env.XDG_CACHE_HOME
        : path.join(env.HOME, ".cache"),
      "tauri",
    );
  return path.join(env.LOCALAPPDATA, "tauri");
}

function download(asset, target) {
  const [repository, id, digest] = asset;
  execFileSync(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--connect-timeout",
      "15",
      "--max-time",
      "300",
      "--retry",
      "4",
      "--retry-delay",
      "2",
      "--retry-all-errors",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "-H",
      "Accept: application/octet-stream",
      "-o",
      target,
      `https://api.github.com/repos/${repository}/releases/assets/${id}`,
    ],
    { stdio: "inherit", timeout: 360_000 },
  );
  if (!verifySha256(readFileSync(target), digest))
    throw new Error("Tauri packaging tool checksum mismatch.");
}

export function prepareTauriTools(platform, env = process.env) {
  if (platform !== "Linux" && platform !== "Windows")
    throw new Error("Unsupported packaging platform.");
  const require = createRequire(path.resolve("apps/desktop/package.json"));
  if (require("@tauri-apps/cli/package.json").version !== "2.12.4")
    throw new Error("Update the pinned packaging tools for this Tauri CLI version.");
  if (!env.RUNNER_TEMP || (platform === "Linux" ? !env.HOME : !env.LOCALAPPDATA))
    throw new Error("The runner packaging directories are unavailable.");
  const temporary = mkdtempSync(path.join(env.RUNNER_TEMP, "ork-tauri-tools-"));
  const tools = tauriCache(platform, env);
  try {
    mkdirSync(tools, { recursive: true });
    if (platform === "Linux") {
      for (const [asset, name] of [
        [assets.apprun, "AppRun-x86_64"],
        [assets.linuxdeploy, "linuxdeploy-07333c6-x86_64.AppImage"],
      ]) {
        const target = path.join(temporary, name);
        download(asset, target);
        chmodSync(target, 0o755);
        copyFileSync(target, path.join(tools, name));
      }
    } else {
      const archive = path.join(temporary, "nsis.zip");
      const plugin = path.join(temporary, "nsis_tauri_utils.dll");
      download(assets.nsis, archive);
      download(assets.plugin, plugin);
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Expand-Archive -LiteralPath $env:ORK_TAURI_ARCHIVE -DestinationPath $env:ORK_TAURI_EXTRACT -Force",
        ],
        {
          stdio: "inherit",
          env: { ...env, ORK_TAURI_ARCHIVE: archive, ORK_TAURI_EXTRACT: temporary },
          timeout: 120_000,
        },
      );
      const nsis = path.join(tools, "NSIS");
      rmSync(nsis, { recursive: true, force: true });
      renameSync(path.join(temporary, "nsis-3.13"), nsis);
      const plugins = path.join(nsis, "Plugins", "x86-unicode", "additional");
      mkdirSync(plugins, { recursive: true });
      copyFileSync(plugin, path.join(plugins, "nsis_tauri_utils.dll"));
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  prepareTauriTools(process.env.RUNNER_OS);
