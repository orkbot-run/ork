// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  prepareWindowsSigning,
  verifyWindowsDistribution,
  windowsSigningConfiguration,
} from "./windows-distribution.ts";

const dirs = [];
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ork-signing-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = temp();
  const signTool = path.join(dir, "signtool.exe");
  const dlib = path.join(dir, "Azure.CodeSigning.Dlib.dll");
  writeFileSync(signTool, "tool");
  writeFileSync(dlib, "library");
  return {
    dir,
    env: {
      WINDOWS_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net",
      WINDOWS_SIGNING_ACCOUNT: "fixture-account",
      WINDOWS_SIGNING_PROFILE: "fixture-profile",
      WINDOWS_SIGNTOOL_PATH: signTool,
      WINDOWS_SIGNING_DLIB_PATH: dlib,
      WINDOWS_SIGNING_RECORD_PATH: path.join(dir, "signing-record.jsonl"),
    },
  };
}

it("requires configured Azure signing and creates an argument-safe Tauri signing overlay", () => {
  const { dir, env } = fixture();
  const metadata = path.join(dir, "private metadata.json");
  const overlay = path.join(dir, "release overlay.json");
  assert.throws(() =>
    windowsSigningConfiguration({ ...env, WINDOWS_SIGNING_PROFILE: "" }, metadata),
  );
  assert.throws(() =>
    windowsSigningConfiguration(
      { ...env, WINDOWS_SIGNING_ENDPOINT: "http://evil.example" },
      metadata,
    ),
  );
  assert.throws(() =>
    windowsSigningConfiguration(
      { ...env, WINDOWS_SIGNTOOL_PATH: path.join(dir, "missing") },
      metadata,
    ),
  );
  prepareWindowsSigning(overlay, metadata, env);
  assert.equal(readFileSync(env.WINDOWS_SIGNING_RECORD_PATH, "utf8"), "");
  const input = JSON.parse(readFileSync(metadata, "utf8"));
  assert.equal(input.Endpoint, "https://weu.codesigning.azure.net");
  assert.equal(input.CodeSigningAccountName, "fixture-account");
  assert.equal(input.CertificateProfileName, "fixture-profile");
  assert.ok(input.ExcludeCredentials.includes("EnvironmentCredential"));
  assert.ok(!input.ExcludeCredentials.includes("AzureCliCredential"));
  const command = JSON.parse(readFileSync(overlay, "utf8")).bundle.windows.signCommand;
  assert.equal(command.cmd, "powershell.exe");
  for (const arg of [metadata, "%1", "-NonInteractive"]) assert.ok(command.args.includes(arg));
  assert.throws(() => prepareWindowsSigning(overlay, metadata, env));
});

it("requires one installer and verifies its signed embedded executable against the build", () => {
  const dir = temp();
  const bundle = path.join(dir, "bundle");
  mkdirSync(path.join(bundle, "nsis"), { recursive: true });
  const installer = path.join(bundle, "nsis", "Ork setup.exe");
  const app = path.join(dir, "Ork.exe");
  writeFileSync(installer, "installer");
  writeFileSync(app, "verified application");
  const record = path.join(dir, "record.jsonl");
  writeFileSync(
    record,
    `${JSON.stringify({ path: app, sha256: createHash("sha256").update("verified application").digest("hex") })}\n`,
  );
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    if (command === "7z.exe") {
      const output = args.find((arg) => arg.startsWith("-o")).slice(2);
      writeFileSync(path.join(output, "Ork.exe"), "verified application");
    }
  };
  verifyWindowsDistribution(bundle, app, run, record);
  assert.deepEqual(
    calls.map((call) => call.command),
    ["powershell.exe", "7z.exe", "powershell.exe"],
  );
  assert.ok(calls[0].args.includes(installer));
  assert.match(calls[2].args.at(-1), /Ork\.exe$/);
});

it("rejects a different executable embedded in the installer", () => {
  const dir = temp();
  const bundle = path.join(dir, "bundle");
  mkdirSync(path.join(bundle, "nsis"), { recursive: true });
  writeFileSync(path.join(bundle, "nsis", "installer.exe"), "installer");
  const app = path.join(dir, "Ork.exe");
  writeFileSync(app, "expected");
  const record = path.join(dir, "record.jsonl");
  writeFileSync(
    record,
    `${JSON.stringify({ path: app, sha256: createHash("sha256").update("expected").digest("hex") })}\n`,
  );
  assert.throws(
    () =>
      verifyWindowsDistribution(
        bundle,
        app,
        (command, args) => {
          if (command === "7z.exe")
            writeFileSync(
              path.join(args.find((arg) => arg.startsWith("-o")).slice(2), "Ork.exe"),
              "different",
            );
        },
        record,
      ),
    /does not match/,
  );
});

it("loads the PowerShell signing entry point and rejects missing tools", {
  skip: process.platform !== "win32",
}, () => {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("./windows-distribution.ps1", import.meta.url)),
      "-Mode",
      "verify",
      "-Path",
      path.join(temp(), "fixture.exe"),
    ],
    { encoding: "utf8", env: { ...process.env, WINDOWS_SIGNTOOL_PATH: "" } },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Windows SignTool is unavailable/);
});

it("accepts a successful tool that writes stderr without exposing its output", {
  skip: process.platform !== "win32",
}, () => {
  const fake = path.join(temp(), "fake tool.exe");
  const compile = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Add-Type -TypeDefinition 'public class FakeTool { public static int Main(string[] args) { System.Console.Error.WriteLine("private-marker"); return 0; } }' -OutputAssembly $env:TEST_FAKE_TOOL -OutputType ConsoleApplication`,
    ],
    { encoding: "utf8", env: { ...process.env, TEST_FAKE_TOOL: fake } },
  );
  assert.equal(compile.status, 0, compile.stderr);
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("./windows-distribution.ps1", import.meta.url)),
      "-Mode",
      "verify",
      "-Path",
      fake,
    ],
    { encoding: "utf8", env: { ...process.env, WINDOWS_SIGNTOOL_PATH: fake } },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Windows signature or timestamp is invalid/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-marker|NativeCommandError/);
});
