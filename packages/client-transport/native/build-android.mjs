// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareMobileRust } from "./build-toolchain.mjs";

const native = dirname(fileURLToPath(import.meta.url));
const generated = resolve(native, "../../../apps/mobile/modules/orkbot-transport/generated");
const destination = join(generated, "android");
const cargoTarget = resolve(process.env.CARGO_TARGET_DIR ?? join(native, "target"));
const platforms = [
  ["aarch64-linux-android", "aarch64-linux-android", "arm64-v8a"],
  ["armv7-linux-androideabi", "armv7a-linux-androideabi", "armeabi-v7a"],
  ["x86_64-linux-android", "x86_64-linux-android", "x86_64"],
  ["i686-linux-android", "i686-linux-android", "x86"],
];

async function run(command, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: native,
      env: { ...env, CARGO_TARGET_DIR: cargoTarget },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`Android transport build failed (${code ?? signal})`)),
    );
  });
}

export async function buildAndroidTransport() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const versions =
    sdk && existsSync(join(sdk, "ndk"))
      ? readdirSync(join(sdk, "ndk")).sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true }),
        )
      : [];
  const ndk =
    process.env.ANDROID_NDK_HOME ?? (versions.length ? join(sdk, "ndk", versions.at(-1)) : null);
  if (!ndk) throw new Error("Install the Android NDK before building the native transport");
  const host =
    process.platform === "darwin"
      ? "darwin-x86_64"
      : process.platform === "linux"
        ? "linux-x86_64"
        : "windows-x86_64";
  const tools = join(ndk, "toolchains/llvm/prebuilt", host, "bin");
  const extension = process.platform === "win32" ? ".cmd" : "";
  if (!existsSync(join(tools, `aarch64-linux-android23-clang${extension}`)))
    throw new Error("Unsupported Android NDK toolchain");
  const hash = createHash("sha256");
  for (const name of [
    ...globSync("src/**/*.rs", { cwd: native }),
    "Cargo.toml",
    "Cargo.lock",
    "build-android.mjs",
    "build-toolchain.mjs",
  ].sort())
    hash.update(name).update(readFileSync(join(native, name)));
  hash.update(readFileSync(join(ndk, "source.properties")));
  const version = hash.digest("hex");
  if (
    existsSync(join(destination, "source-version")) &&
    readFileSync(join(destination, "source-version"), "utf8") === version &&
    platforms.every(([, , abi]) =>
      existsSync(join(destination, "jniLibs", abi, "libork_installation_transport.so")),
    )
  )
    return;
  mkdirSync(generated, { recursive: true });
  const temporary = mkdtempSync(join(generated, ".android-"));
  try {
    const rust = await prepareMobileRust(
      platforms.map(([target]) => target),
      join(cargoTarget, "mobile-toolchain"),
    );
    const cargo = (args, env = rust.env) =>
      run(rust.command, [...rust.prefix, "cargo", ...args], env);
    await cargo(["build", "--locked", "--features", "bindgen"]);
    const library =
      process.platform === "darwin"
        ? "libork_installation_transport.dylib"
        : process.platform === "win32"
          ? "ork_installation_transport.dll"
          : "libork_installation_transport.so";
    await cargo([
      "run",
      "--locked",
      "--features",
      "bindgen",
      "--bin",
      "ork-transport-bindgen",
      "--",
      "generate",
      "--library",
      join(cargoTarget, "debug", library),
      "--language",
      "kotlin",
      "--out-dir",
      join(temporary, "kotlin"),
      "--no-format",
    ]);
    for (const [target, compiler, abi] of platforms) {
      const key = target.replaceAll("-", "_");
      const cc = join(tools, `${compiler}23-clang${extension}`);
      const env = {
        ...rust.env,
        [`CC_${key}`]: cc,
        [`AR_${key}`]: join(tools, process.platform === "win32" ? "llvm-ar.exe" : "llvm-ar"),
        [`CARGO_TARGET_${key.toUpperCase()}_LINKER`]: cc,
        [`CARGO_TARGET_${key.toUpperCase()}_RUSTFLAGS`]: "-C link-arg=-Wl,-z,max-page-size=16384",
      };
      await cargo(["build", "--locked", "--release", "--lib", "--target", target], env);
      const output = join(temporary, "jniLibs", abi);
      mkdirSync(output, { recursive: true });
      cpSync(
        join(cargoTarget, target, "release/libork_installation_transport.so"),
        join(output, "libork_installation_transport.so"),
      );
    }
    writeFileSync(join(temporary, "source-version"), version);
    rmSync(destination, { recursive: true, force: true });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildAndroidTransport();
