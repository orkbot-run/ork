// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("keeps signing secrets out of PR builds and publishes only after both exact-revision workflows", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const build = parse(readFileSync(path.join(root, ".github/workflows/desktop-tauri.yml"), "utf8"));
  const signed = build.jobs["diagnostic-build"].steps.find(
    (step: { name?: string }) => step.name === "Build signed updates",
  );
  expect(signed.if).toContain("github.event_name == 'release'");
  expect(signed.if).not.toContain("github.ref == 'refs/heads/main'");
  expect(existsSync(path.join(root, ".github/workflows/desktop-tauri-publish.yml"))).toBe(false);
  expect(existsSync(path.join(root, ".github/scripts/publish-tauri.mjs"))).toBe(false);
  expect(signed.env.ORKBOT_ENABLE_AUTO_UPDATE).toBe("1");
  expect(signed.env.TAURI_UPDATER_ENDPOINT).toContain("/desktop-stable/latest.json");
  expect(signed.env.TAURI_UPDATER_BETA_ENDPOINT).toContain("/desktop-beta/latest.json");
  expect(build.on.release.types).toEqual(["published"]);
  expect(build.jobs["publish-release"].needs).toEqual([
    "diagnostic-build",
    "windows-signed-release",
  ]);
  expect(build.jobs["publish-release"].steps[0].with.ref).toBe("main");
  expect(signed.run).toContain("macos-distribution.ts prepare");
  expect(signed.run).toContain("macos-distribution.ts verify");
  expect(signed.run.indexOf("macos-distribution.ts verify")).toBeLessThan(
    signed.run.indexOf("tauri-release.ts stage"),
  );
  expect(signed.env.APPLE_CERTIFICATE).toContain("runner.os == 'macOS'");
  expect(build.permissions).toEqual({ contents: "read" });
  const matrix = build.jobs["diagnostic-build"].strategy.matrix.include as string;
  const branches = [...matrix.matchAll(/'([[][^']+)'/g)].map((match) => JSON.parse(match[1]!));
  expect(branches).toHaveLength(2);
  expect(branches[0].map((entry: { platform: string }) => entry.platform)).toEqual([
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-x86_64",
  ]);
  expect(branches[1].map((entry: { platform: string }) => entry.platform)).toEqual([
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-x86_64",
    "linux-x86_64",
  ]);
  expect(
    branches[0].find((entry: { platform: string }) => entry.platform === "linux-x86_64").os,
  ).toBe("ubuntu-22.04");
  const windowsTools = build.jobs["diagnostic-build"].steps.find(
    (step: { name?: string }) => step.name === "Prepare verified Windows signing tools",
  );
  expect(windowsTools.if).toBe("runner.os == 'Windows'");
  expect(windowsTools.run).toContain("prepare-windows-signing-tools.mjs");
  const windowsToolCheck = build.jobs["diagnostic-build"].steps.find(
    (step: { name?: string }) => step.name === "Check Windows signing tools",
  );
  expect(windowsToolCheck.if).toBe("runner.os == 'Windows'");
  expect(windowsToolCheck.run).toContain('spawnSync(process.env.WINDOWS_SIGNTOOL_PATH, ["/?"]');
  expect(windowsToolCheck.run).toContain("Usage:");
  expect(windowsToolCheck.run).toContain("result.status");
  expect(windowsToolCheck.run).toContain("WINDOWS_SIGNING_DLIB_PATH");
  const helpers = build.jobs["diagnostic-build"].steps.find(
    (step: { name?: string }) => step.name === "Configure Linux WebKit helpers",
  );
  expect(helpers.if).toBe("runner.os == 'Linux'");
  expect(helpers.run).toContain("/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1");
  const packaging = build.jobs["diagnostic-build"].steps.find(
    (step: { name?: string }) => step.name === "Prepare verified packaging tools",
  );
  expect(packaging.env.GITHUB_TOKEN).toBe(`\${{ github.token }}`);
  expect(signed.run).toContain("linux-webkit.json");
  const windowsOffline = build.jobs["diagnostic-build"].steps.find(
    (step: { name?: string }) => step.name === "Test Windows signing helpers offline",
  );
  expect(windowsOffline.if).toBe("runner.os == 'Windows'");
  expect(windowsOffline.run).toContain("windows-distribution.test.mjs");
  expect(windowsOffline.run).toContain("prepare-windows-signing-tools.test.mjs");
  const windowsParser = build.jobs["diagnostic-build"].steps.find(
    (step: { name?: string }) => step.name === "Parse Windows signing script",
  );
  expect(windowsParser.if).toBe("runner.os == 'Windows'");
  expect(windowsParser.run).toContain("Language.Parser]::ParseFile");
  const diagnostic = build.jobs["diagnostic-build"].steps.find(
    (step: { name?: string }) => step.name === "Build diagnostic installers",
  );
  expect(diagnostic.run).toContain(
    'tauri:build --verbose --config "$RUNNER_TEMP/linux-webkit.json"',
  );
  expect(diagnostic.if).toBe("github.event_name != 'release'");
  const command = signed.run.slice(
    signed.run.indexOf('case "$RUNNER_OS" in'),
    signed.run.indexOf(
      'if [[ "$RUNNER_OS" == macOS ]]; then\n  node apps/desktop/scripts/macos-distribution.ts verify',
    ),
  );
  expect(command).toContain('Linux) bundles="appimage"');
  for (const [os, bundle, verbose] of [
    ["macOS", "app,dmg", false],
    ["Windows", "nsis", false],
    ["Linux", "appimage", true],
  ] as const) {
    const result = execFileSync(
      "bash",
      ["-c", `set -eu; pnpm() { printf '%s\\n' "$@"; }; ${command}`],
      {
        encoding: "utf8",
        env: { ...process.env, RUNNER_OS: os, RUNNER_TEMP: "/tmp/tauri-workflow-test" },
      },
    )
      .trim()
      .split("\n");
    expect(result).toContain(bundle);
    expect(result.includes("--verbose")).toBe(verbose);
  }
  expect(build.jobs["publish-release"].concurrency.queue).toBe("max");
  expect(build.jobs["publish-release"].concurrency["cancel-in-progress"]).toBe(false);
});

it("limits cloud signing credentials to the protected Windows release job", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const workflow = parse(
    readFileSync(path.join(root, ".github/workflows/desktop-tauri.yml"), "utf8"),
  );
  const job = workflow.jobs["windows-signed-release"];
  expect(job.if).toContain("github.event_name == 'release'");
  expect(job.environment).toBe("desktop-windows-signing");
  expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
  expect(workflow.jobs["diagnostic-build"].permissions?.["id-token"]).toBeUndefined();
  const steps = job.steps as {
    name?: string;
    uses?: string;
    run?: string;
    with?: Record<string, string>;
    env?: Record<string, string>;
  }[];
  const validate = steps.findIndex((step) => step.name === "Validate signing configuration");
  const login = steps.findIndex((step) => step.uses?.startsWith("azure/login@"));
  const prepare = steps.findIndex((step) => step.name === "Prepare Windows signing configuration");
  const build = steps.findIndex((step) => step.name === "Build and verify signed Windows update");
  expect(validate).toBeGreaterThanOrEqual(0);
  expect(prepare).toBeGreaterThan(validate);
  expect(login).toBeGreaterThan(prepare);
  expect(build).toBeGreaterThan(login);
  expect(steps[login]!.uses).toBe("azure/login@a457da9ea143d694b1b9c7c869ebb04ebe844ef5");
  for (const key of [
    "WINDOWS_SIGNING_ENDPOINT",
    "WINDOWS_SIGNING_ACCOUNT",
    "WINDOWS_SIGNING_PROFILE",
    "AZURE_CLIENT_ID",
    "AZURE_TENANT_ID",
    "AZURE_SUBSCRIPTION_ID",
    "TAURI_SIGNING_PRIVATE_KEY",
  ]) {
    expect(steps[validate]!.run).toContain(key);
  }
  const cleanup = steps.find((step) => step.name === "Remove Windows signing metadata") as
    | { if?: string; run?: string }
    | undefined;
  expect(cleanup?.if).toBe("always()");
  expect(cleanup?.run).toContain("WINDOWS_SIGNING_RECORD_PATH");
  expect(cleanup?.run).toContain("windows-metadata.json");
  const run = steps[build]!.run!;
  expect(run).toContain("WINDOWS_SIGNING_RECORD_PATH");
  expect(steps[prepare]!.env?.WINDOWS_SIGNING_RECORD_PATH).toContain("runner.temp");
  expect(steps[prepare]!.run).toContain("GITHUB_ENV");
  expect(steps[prepare]!.run!.indexOf("GITHUB_ENV")).toBeLessThan(
    steps[prepare]!.run!.indexOf("windows-distribution.ts prepare"),
  );
  expect(run).toContain("windows-distribution.ts verify");
  expect(run.indexOf("windows-distribution.ts verify")).toBeLessThan(
    run.indexOf("tauri-release.ts stage"),
  );
  expect(steps.some((step) => step.run?.includes("prepare-windows-signing-tools.mjs"))).toBe(true);
  expect(workflow.on.pull_request.paths).toContain(
    ".github/scripts/prepare-windows-signing-tools.mjs",
  );
});

it("accepts only a real SignTool help response from the Windows preflight", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const workflow = parse(
    readFileSync(path.join(root, ".github/workflows/desktop-tauri.yml"), "utf8"),
  );
  const step = workflow.jobs["diagnostic-build"].steps.find(
    (item: { name?: string }) => item.name === "Check Windows signing tools",
  );
  const script = step.run.match(/node -e '\n([\s\S]*?)\n\s*'/)?.[1];
  expect(script).toBeTruthy();
  const run = (result: { status: number | null; stdout: string; stderr: string; error?: Error }) =>
    runInNewContext(script, {
      process: { env: { WINDOWS_SIGNTOOL_PATH: "tool", WINDOWS_SIGNING_DLIB_PATH: "dlib" } },
      console: { log: () => {} },
      require: (module: string) =>
        module === "node:fs"
          ? { statSync: () => ({ isFile: () => true }) }
          : { spawnSync: () => result },
    });
  expect(() => run({ status: 1, stdout: "", stderr: "Usage: signtool [options]" })).not.toThrow();
  expect(() => run({ status: 0, stdout: "Usage: signtool [options]", stderr: "" })).not.toThrow();
  expect(() => run({ status: 1, stdout: "", stderr: "DLL missing" })).toThrow();
  expect(() => run({ status: 2, stdout: "", stderr: "Usage: signtool" })).toThrow();
  expect(() => run({ status: null, stdout: "", stderr: "", error: new Error("spawn") })).toThrow();
});
