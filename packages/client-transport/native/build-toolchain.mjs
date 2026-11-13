// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

async function execute(command, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Rust setup failed (${code ?? signal})`));
    });
  });
}

async function download(url, limit) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error("Rust installer download failed");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Rust installer exceeds the download limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** Cloud builds install their compiler in ignored build output, without changing shell profiles. */
export async function prepareMobileRust(targets, directory, environment = process.env) {
  let env = { ...environment };
  let command = "rustup";
  if (spawnSync(command, ["--version"], { env, stdio: "ignore" }).status !== 0) {
    if (env.EAS_BUILD !== "true")
      throw new Error("Install rustup before building the native transport");
    const hosts = {
      "darwin-arm64": "aarch64-apple-darwin",
      "darwin-x64": "x86_64-apple-darwin",
      "linux-x64": "x86_64-unknown-linux-gnu",
      "linux-arm64": "aarch64-unknown-linux-gnu",
    };
    const host = hosts[`${process.platform}-${process.arch}`];
    if (!host) throw new Error("Unsupported Rust build host");
    const cargo = join(directory, "cargo");
    env = { ...env, CARGO_HOME: cargo, RUSTUP_HOME: join(directory, "rustup") };
    mkdirSync(directory, { recursive: true });
    const temporary = mkdtempSync(join(directory, ".installer-"));
    try {
      const url = `https://static.rust-lang.org/rustup/dist/${host}/rustup-init`;
      const expected = (await download(`${url}.sha256`, 1024))
        .toString("utf8")
        .trim()
        .split(/\s+/)[0];
      const bytes = await download(url, 64 * 1024 * 1024);
      if (
        !/^[a-f0-9]{64}$/.test(expected ?? "") ||
        createHash("sha256").update(bytes).digest("hex") !== expected
      )
        throw new Error("Rust installer checksum mismatch");
      const installer = join(temporary, "rustup-init");
      writeFileSync(installer, bytes, { mode: 0o700 });
      await execute(
        installer,
        ["-y", "--no-modify-path", "--default-toolchain", "none", "--profile", "minimal"],
        env,
      );
      command = join(cargo, "bin/rustup");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  const toolchain = env.RUSTUP_TOOLCHAIN ?? "stable";
  if (
    spawnSync(command, ["run", toolchain, "rustc", "--version"], { env, stdio: "ignore" })
      .status !== 0
  ) {
    await execute(command, ["toolchain", "install", toolchain, "--profile", "minimal"], env);
  }
  await execute(command, ["component", "add", "llvm-tools", "--toolchain", toolchain], env);
  await execute(command, ["target", "add", "--toolchain", toolchain, ...targets], env);
  const compiler = spawnSync(command, ["which", "--toolchain", toolchain, "rustc"], {
    env,
    encoding: "utf8",
  });
  if (compiler.status !== 0 || !compiler.stdout.trim())
    throw new Error("Rust compiler is unavailable");
  const rustc = compiler.stdout.trim();
  // Cargo must not pick a different compiler installed earlier on PATH.
  env = { ...env, RUSTC: rustc, PATH: `${dirname(rustc)}${delimiter}${env.PATH ?? ""}` };
  return { command, prefix: ["run", toolchain], env };
}
