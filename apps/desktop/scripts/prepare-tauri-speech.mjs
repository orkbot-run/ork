// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { spawnSync } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const desktop = path.resolve(path.dirname(script), "..");

/** Build the existing helper with its canonical Swift recipe and embedded privacy declarations. */
export async function prepareTauriSpeech() {
  if (process.platform !== "darwin") return null;
  const build = spawnSync(process.execPath, [path.join(desktop, "scripts/build-speech.mjs")], {
    stdio: "inherit",
  });
  if (build.error || build.status !== 0) {
    throw new Error("Could not build the macOS speech helper.");
  }
  const helper = path.join(desktop, "build/speech/orkbot-speech");
  const metadata = await lstat(helper).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0) {
    throw new Error(
      "The macOS speech helper is unavailable. Install the Swift build tools and retry.",
    );
  }
  return helper;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) await prepareTauriSpeech();
