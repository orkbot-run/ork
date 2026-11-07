// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

/** Bundle the actual CLI, replacing only its database, storage and environment boundaries. */
async function command(
  phase: "upload" | "scan" | "cleanup" | "success" | "failure" | "secret-close-error",
  args = ["migrate"],
  entry = "home-storage",
) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`./${entry}.ts`, import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "offline-migration-boundaries",
        setup(builder) {
          builder.onResolve({ filter: /^(?:@orkbot\/|#modules\/)/ }, () => ({
            path: "dependencies",
            namespace: "offline",
          }));
          builder.onLoad({ filter: /.*/, namespace: "offline" }, () => ({
            contents: `
const phase = ${JSON.stringify(phase)};
let release;
const gate = new Promise(resolve => { release = resolve; });
process.once("message", () => release());
const pause = async label => { process.send(label); await gate; };
export function loadRootEnv() {}
export async function unwrapEnvFromKeyManager() {}
export function contentKeyProviderFromEnv() {}
export function createDb() {
  return { prisma: { async $disconnect() {
    console.log("cleanup database");
    if (phase === "cleanup") await pause("cleanup");
  } }, pool: { async end() { console.log("cleanup pool"); } } };
}
export class ObjectAgentHomeStore {
  async localHomes() {
    if (phase === "scan") await pause("scan");
    return ["fixture-home-1", "fixture-home-2"];
  }
  async migrateLocal(key, options) {
    console.log("migrate " + key);
    if (phase === "upload" && key === "fixture-home-1") await pause("upload");
    if (phase === "failure") throw new Error("fixture upload failed");
    return options.dryRun ? "would-upload" : "uploaded";
  }
}
export function createAgentHomeStore() { return new ObjectAgentHomeStore(); }
export function resolveEncryptionKey() { return "fixture"; }
export function resolveContentEncryption() { return false; }
export function runAsSystem(_reason, operation) { return operation(); }
export class LocalArtifactStore {}
export function createSecretMigrationRepository() { return {}; }
export function createSecretStore() { throw new Error("unexpected secret access"); }
export class EncryptedSecretStore {}
export class InfisicalSecretStore {}
let closedStores = 0;
export class ComposedSecretStore {
  async start() {}
  async close() {
    console.log("cleanup secret store");
    if (phase === "secret-close-error" && ++closedStores === 1) throw new Error("fixture close failed");
  }
}
export class PostgresRealtimeFanout { async close() { console.log("cleanup realtime"); } }
export function secretStoreOptionsFromEnv() { return {}; }
export async function migrateSecrets() {
  if (phase === "upload") await pause("upload");
  return { failed: 0 };
}
export async function rewrapSpaceKeys() {
  if (phase === "upload") await pause("upload");
  return { rewrapped: 0, current: 0 };
}
export function withSecretPersistence() {}
export function upgradeLegacySecrets() { throw new Error("unexpected credential migration"); }
export function moveMcpArgsIntoSecrets() { throw new Error("unexpected MCP migration"); }
export function contentEncryptionStatus() { throw new Error("unexpected status"); }
export function exportContent() { throw new Error("unexpected export"); }
export function migrateContent() { throw new Error("unexpected content migration"); }
export function rotateSpaceDataKeys() { throw new Error("unexpected key rotation"); }
`,
          }));
        },
      },
    ],
  });
  const dir = mkdtempSync(path.join(tmpdir(), "ork-migration-test-"));
  const executable = path.join(dir, "home-storage.mjs");
  writeFileSync(
    executable,
    `
process.once("SIGINT", () => process.send("signal"));
process.once("SIGTERM", () => process.send("signal"));
${result.outputFiles[0]!.text}
process.disconnect();
`,
  );
  const child = spawn(process.execPath, ["--no-warnings", executable, ...args], {
    env: { ...process.env, DATABASE_URL: "postgres://fixture.invalid/offline" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr!.on("data", (chunk) => {
    output += chunk.toString();
  });
  const messages: unknown[] = [];
  child.on("message", (message) => messages.push(message));
  const closed = once(child, "close").then(([code, signal]) => ({ code, signal }));
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 8_000);
  const wait = async (message: string) => {
    while (!messages.includes(message)) {
      await Promise.race([
        once(child, "message"),
        closed.then(() => {
          throw new Error(`CLI exited before ${message}: ${output}`);
        }),
      ]);
    }
  };
  return {
    child,
    closed,
    wait,
    output: () => output,
    dispose() {
      clearTimeout(watchdog);
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  it.each(["upload", "scan", "cleanup"] as const)(
    `exits ${code} after ${signal} during %s and drains owned cleanup`,
    async (phase) => {
      const cli = await command(phase);
      try {
        await cli.wait(phase);
        cli.child.kill(signal);
        await cli.wait("signal");
        cli.child.send("finish current step");
        expect(await cli.closed).toEqual({ code, signal: null });
        expect(cli.output()).toContain("cleanup database");
        expect(cli.output()).toContain("cleanup pool");
        if (phase !== "cleanup") {
          expect(cli.output()).toContain("stopped early; run it again to continue");
          expect(cli.output()).not.toContain("migrate fixture-home-2");
        }
      } finally {
        cli.dispose();
      }
    },
  );
}

it.each([
  ["success", 0],
  ["failure", 1],
] as const)("preserves %s status without a signal", async (phase, code) => {
  const cli = await command(phase);
  try {
    expect(await cli.closed).toEqual({ code, signal: null });
    expect(cli.output()).toContain("cleanup database");
    expect(cli.output()).toContain("cleanup pool");
    expect(cli.output()).not.toContain("stopped early");
  } finally {
    cli.dispose();
  }
});

it("keeps usage failure separate from migration cleanup", async () => {
  const cli = await command("success", ["invalid"]);
  try {
    expect(await cli.closed).toEqual({ code: 2, signal: null });
    expect(cli.output()).toContain("Usage: home-storage");
    expect(cli.output()).not.toContain("cleanup database");
  } finally {
    cli.dispose();
  }
});

for (const entry of ["content-encryption", "secrets-infisical"]) {
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    it(`also drains ${entry} after ${signal} instead of reporting a successful partial command`, async () => {
      const cli = await command("upload", entry === "content-encryption" ? ["rotate"] : [], entry);
      try {
        await cli.wait("upload");
        cli.child.kill(signal);
        await cli.wait("signal");
        cli.child.send("finish current step");
        expect(await cli.closed).toEqual({ code, signal: null });
        expect(cli.output()).toContain("cleanup database");
        expect(cli.output()).toContain("cleanup pool");
        if (entry === "secrets-infisical") {
          expect(cli.output().match(/cleanup secret store/g)).toHaveLength(2);
          expect(cli.output()).toContain("cleanup realtime");
        }
      } finally {
        cli.dispose();
      }
    });
  }
}

it("still releases other resources when a secret store close fails, without hiding the failure", async () => {
  const cli = await command("secret-close-error", [], "secrets-infisical");
  try {
    expect(await cli.closed).toEqual({ code: 1, signal: null });
    expect(cli.output().match(/cleanup secret store/g)).toHaveLength(2);
    expect(cli.output()).toContain("cleanup realtime");
    expect(cli.output()).toContain("cleanup database");
    expect(cli.output()).toContain("cleanup pool");
  } finally {
    cli.dispose();
  }
});
