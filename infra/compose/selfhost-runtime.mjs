// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

/** Read only a regular, private configuration created by selfhost-init. */
export function readRuntimeConfig(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 32_768 || (stat.mode & 0o077) !== 0)
      throw new Error("Invalid self-host runtime configuration.");
    const config = JSON.parse(readFileSync(fd, "utf8"));
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      Object.entries(config).some(
        ([key, value]) =>
          !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0"),
      )
    )
      throw new Error("Invalid self-host runtime configuration.");
    return config;
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const [config, executable, ...args] = process.argv.slice(2);
    if (!config || !executable) throw new Error("Runtime configuration and command are required.");
    const child = spawn(executable, args, {
      stdio: "inherit",
      env: { ...process.env, ...readRuntimeConfig(config) },
    });
    const forward = (signal) => child.kill(signal);
    const onTerm = () => forward("SIGTERM");
    const onInt = () => forward("SIGINT");
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    child.on("error", () => {
      process.stderr.write("Could not start the self-host service.\n");
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      process.removeListener("SIGTERM", onTerm);
      process.removeListener("SIGINT", onInt);
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
    });
  } catch {
    process.stderr.write("Could not load the self-host runtime configuration.\n");
    process.exitCode = 1;
  }
}
