// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { runPnpm } from "../../../scripts/pnpm.mjs";
import { APP_DOCUMENT_STATE_SCRIPT } from "../src/app-document-script.ts";
import { buildPackagedRenderer } from "./build-renderer.mjs";
import { prepareTauriSpeech } from "./prepare-tauri-speech.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "build/tauri-ui");
const native = path.join(root, "build/tauri-native");
await buildPackagedRenderer(path.join(root, "build/tauri-renderer"));
await rm(native, { recursive: true, force: true });
await mkdir(native, { recursive: true });
const helper = await prepareTauriSpeech();
if (helper) {
  const staged = path.join(native, "orkbot-speech");
  await copyFile(helper, staged);
  const sign = spawnSync(
    "codesign",
    [
      "--force",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--entitlements",
      path.join(root, "src-tauri/Entitlements.plist"),
      staged,
    ],
    { encoding: "utf8" },
  );
  const verify = spawnSync("codesign", ["--verify", "--strict", staged], { encoding: "utf8" });
  if (sign.status !== 0 || verify.status !== 0)
    throw new Error("Could not sign the local speech helper.");
  const entitlements = spawnSync("codesign", ["-d", "--entitlements", ":-", staged], {
    encoding: "utf8",
  });
  const plist = spawnSync("plutil", ["-convert", "json", "-o", "-", "-"], {
    encoding: "utf8",
    input: entitlements.stdout,
  });
  let microphone = false;
  try {
    microphone =
      entitlements.status === 0 &&
      plist.status === 0 &&
      JSON.parse(plist.stdout)?.["com.apple.security.device.audio-input"] === true;
  } catch {
    // Malformed signed metadata must fail the build.
  }
  if (!microphone) {
    throw new Error("The signed speech helper is missing its microphone entitlement.");
  }
  const slices = spawnSync("xcrun", ["lipo", "-archs", staged], { encoding: "utf8" });
  if (slices.status !== 0) throw new Error("Could not inspect the speech helper architectures.");
  const architectures = slices.stdout.trim().split(/\s+/);
  for (const [architecture, target] of [
    ["arm64", "aarch64-apple-darwin"],
    ["x86_64", "x86_64-apple-darwin"],
  ]) {
    if (architectures.includes(architecture)) await copyFile(staged, `${staged}-${target}`);
  }
  if (architectures.includes("arm64") && architectures.includes("x86_64")) {
    await copyFile(staged, `${staged}-universal-apple-darwin`);
  }
}
runPnpm(
  [
    "exec",
    "tauri",
    "icon",
    path.join(root, "assets/icon.png"),
    "--output",
    path.join(root, "build/tauri-icons"),
  ],
  { cwd: root, stdio: "pipe" },
);
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "app-document-script.js"), APP_DOCUMENT_STATE_SCRIPT);
const locales = {};
for (const file of await readdir(path.join(root, "src/locales"))) {
  if (!file.endsWith(".ts")) continue;
  const catalog = await import(pathToFileURL(path.join(root, "src/locales", file)).href);
  locales[file.slice(0, -3)] = Object.values(catalog)[0];
}
await writeFile(path.join(output, "desktop-locales.json"), JSON.stringify(locales));
await copyFile(path.join(root, "tauri-ui/index.html"), path.join(output, "index.html"));
await copyFile(path.join(root, "src/setup.css"), path.join(output, "setup.css"));
await copyFile(
  path.join(root, "../../packages/ui-tokens/src/tokens.css"),
  path.join(output, "tokens.css"),
);
await build({
  entryPoints: [path.join(root, "tauri-ui/setup.ts")],
  outfile: path.join(output, "setup.js"),
  bundle: true,
  format: "iife",
  target: "es2022",
});
await build({
  entryPoints: [path.join(root, "tauri-ui/native-bridge.ts")],
  outfile: path.join(output, "native-bridge.js"),
  bundle: true,
  format: "iife",
  target: "es2022",
});
