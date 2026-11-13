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
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareMobileRust } from "./build-toolchain.mjs";

const native = dirname(fileURLToPath(import.meta.url));
const root = resolve(native, "../../..");
const generated = join(root, "apps/mobile/modules/orkbot-transport/generated");
const destination = join(generated, "apple");
const targets = ["aarch64-apple-ios", "aarch64-apple-ios-sim", "x86_64-apple-ios"];
const cargoTarget = resolve(process.env.CARGO_TARGET_DIR ?? join(native, "target"));

async function run(command, args, environment = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: native,
      env: { ...environment, CARGO_TARGET_DIR: cargoTarget },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Installation transport build failed (${command}: ${code ?? signal})`));
    });
  });
}

export async function buildAppleTransport() {
  if (process.platform !== "darwin") throw new Error("Apple transport requires macOS and Xcode");
  const hash = createHash("sha256");
  for (const name of [
    ...globSync("src/**/*.rs", { cwd: native }),
    ...globSync("apple/*.swift", { cwd: native }),
    "Cargo.toml",
    "Cargo.lock",
    "build-apple.mjs",
    "build-toolchain.mjs",
  ].sort()) {
    hash.update(name).update(readFileSync(join(native, name)));
  }
  const version = hash.digest("hex");
  if (
    existsSync(join(destination, "source-version")) &&
    readFileSync(join(destination, "source-version"), "utf8") === version &&
    existsSync(join(destination, "OrkInstallationTransport.xcframework/Info.plist"))
  )
    return;
  mkdirSync(generated, { recursive: true });
  const temporary = mkdtempSync(join(generated, ".apple-"));
  try {
    const rust = await prepareMobileRust(targets, join(cargoTarget, "mobile-toolchain"));
    const cargo = (args) => run(rust.command, [...rust.prefix, "cargo", ...args], rust.env);
    await cargo(["build", "--locked", "--features", "bindgen"]);
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
      join(cargoTarget, "debug/libork_installation_transport.dylib"),
      "--language",
      "swift",
      "--out-dir",
      join(temporary, "Bindings"),
      "--no-format",
    ]);
    for (const target of targets) {
      await cargo(["build", "--locked", "--release", "--lib", "--target", target]);
    }
    const headers = join(temporary, "Headers");
    mkdirSync(headers);
    cpSync(
      join(temporary, "Bindings/ork_installation_transportFFI.h"),
      join(headers, "ork_installation_transportFFI.h"),
    );
    cpSync(
      join(temporary, "Bindings/ork_installation_transportFFI.modulemap"),
      join(headers, "module.modulemap"),
    );
    const simulator = join(temporary, "Simulator/libork_installation_transport.a");
    mkdirSync(dirname(simulator));
    await run("xcrun", [
      "lipo",
      "-create",
      join(cargoTarget, "aarch64-apple-ios-sim/release/libork_installation_transport.a"),
      join(cargoTarget, "x86_64-apple-ios/release/libork_installation_transport.a"),
      "-output",
      simulator,
    ]);
    await run("xcodebuild", [
      "-create-xcframework",
      "-library",
      join(cargoTarget, "aarch64-apple-ios/release/libork_installation_transport.a"),
      "-headers",
      headers,
      "-library",
      simulator,
      "-headers",
      headers,
      "-output",
      join(temporary, "OrkInstallationTransport.xcframework"),
    ]);
    const sources = join(temporary, "Sources");
    mkdirSync(sources);
    cpSync(
      join(temporary, "Bindings/ork_installation_transport.swift"),
      join(sources, "ork_installation_transport.swift"),
    );
    for (const source of globSync("apple/*.swift", { cwd: native })) {
      cpSync(join(native, source), join(sources, source.slice("apple/".length)));
    }
    for (const directory of ["Bindings", "Headers", "Simulator"])
      rmSync(join(temporary, directory), { recursive: true });
    writeFileSync(join(temporary, "source-version"), version);
    rmSync(destination, { recursive: true, force: true });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildAppleTransport();
}
