// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: This CI script is not a Turbo task.
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 50 * 1024 * 1024;
const packages = [
  {
    url: "https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.buildtools/10.0.26100.3916/microsoft.windows.sdk.buildtools.10.0.26100.3916.nupkg",
    sha512:
      "3dca54ecefe7a7366816bbc37668e8a5b3588c918b5e164cbaee7beda2bf8b558fc83083fe02da64d3c9701181f7edca097f0b51b8cbe677a649a29676680332",
    file: "bin/10.0.26100.0/x64/signtool.exe",
    variable: "WINDOWS_SIGNTOOL_PATH",
  },
  {
    url: "https://api.nuget.org/v3-flatcontainer/microsoft.artifactsigning.client/1.0.128/microsoft.artifactsigning.client.1.0.128.nupkg",
    sha512:
      "98f06a691f4fc2fa22f19dcf8556733e98607fbef91a312c453b9b0798cc9088dae0acb36e389b552a11b4d2320324785b8541c2b51091a724c05bc5df5cbf95",
    file: "bin/x64/Azure.CodeSigning.Dlib.dll",
    variable: "WINDOWS_SIGNING_DLIB_PATH",
  },
];

export function prepareWindowsSigningTools(
  env = process.env,
  execute = execFileSync,
  assets = packages,
) {
  if (
    env.RUNNER_OS !== "Windows" ||
    !env.RUNNER_TEMP ||
    !env.GITHUB_ENV ||
    /[\r\n]/.test(env.RUNNER_TEMP) ||
    /[\r\n]/.test(env.GITHUB_ENV)
  )
    throw new Error("Windows runner directories are unavailable.");
  const root = mkdtempSync(path.join(env.RUNNER_TEMP, "ork-windows-signing-"));
  let success = false;
  try {
    for (const [index, asset] of assets.entries()) {
      const archive = path.join(root, `${index}.nupkg`);
      execute(
        "curl.exe",
        [
          "--disable",
          "--fail",
          "--silent",
          "--show-error",
          "--location",
          "--proto",
          "=https",
          "--proto-redir",
          "=https",
          "--connect-timeout",
          "15",
          "--max-time",
          "120",
          "--max-filesize",
          String(MAX_BYTES),
          "--output",
          archive,
          asset.url,
        ],
        { stdio: "ignore", timeout: 130_000 },
      );
      const size = statSync(archive).size;
      if (
        size === 0 ||
        size > MAX_BYTES ||
        createHash("sha512").update(readFileSync(archive)).digest("hex") !== asset.sha512
      )
        throw new Error("Signing tool package verification failed.");
    }
    const lines = [];
    for (const [index, asset] of assets.entries()) {
      const destination = path.join(root, String(index));
      execute("7z.exe", ["x", "-y", `-o${destination}`, path.join(root, `${index}.nupkg`)], {
        stdio: "ignore",
        timeout: 120_000,
      });
      const file = path.join(destination, asset.file);
      if (!statSync(file).isFile() || /[\r\n]/.test(file))
        throw new Error("Signing tool is missing.");
      lines.push(`${asset.variable}=${file}`);
    }
    appendFileSync(env.GITHUB_ENV, `${lines.join("\n")}\n`);
    success = true;
  } finally {
    if (!success) rmSync(root, { recursive: true, force: true });
    else
      for (const index of assets.keys()) rmSync(path.join(root, `${index}.nupkg`), { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  prepareWindowsSigningTools();
