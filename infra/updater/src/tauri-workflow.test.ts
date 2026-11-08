// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("keeps signing secrets out of PR builds and publishes only after both exact-revision workflows", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const build = parse(readFileSync(path.join(root, ".github/workflows/desktop-tauri.yml"), "utf8"));
  const signed = build.jobs["diagnostic-build"].steps.find(
    (step: { name?: string }) => step.name === "Build signed Preview updates",
  );
  expect(signed.if).toContain("github.ref == 'refs/heads/main'");
  expect(signed.if).toContain("github.event_name != 'pull_request'");
  expect(signed.env.ORKBOT_ENABLE_AUTO_UPDATE).toBe("1");
  expect(signed.run).toContain("macos-distribution.ts prepare");
  expect(signed.run).toContain("macos-distribution.ts verify");
  expect(signed.run.indexOf("macos-distribution.ts verify")).toBeLessThan(
    signed.run.indexOf("tauri-release.ts stage"),
  );
  expect(signed.env.APPLE_CERTIFICATE).toContain("runner.os == 'macOS'");
  expect(build.permissions).toEqual({ contents: "read" });
  expect(
    build.jobs["diagnostic-build"].strategy.matrix.include.map(
      (entry: { platform: string }) => entry.platform,
    ),
  ).toEqual(["darwin-aarch64", "darwin-x86_64", "windows-x86_64", "linux-x86_64"]);
  const linux = build.jobs["diagnostic-build"].strategy.matrix.include.find(
    (entry: { platform: string }) => entry.platform === "linux-x86_64",
  );
  expect(linux.os).toBe("ubuntu-22.04");
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
  const diagnostic = build.jobs["diagnostic-build"].steps.find(
    (step: { name?: string }) => step.name === "Build diagnostic installers",
  );
  expect(diagnostic.run).toContain(
    'tauri:build --verbose --config "$RUNNER_TEMP/linux-webkit.json"',
  );
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
  const publish = parse(
    readFileSync(path.join(root, ".github/workflows/desktop-tauri-publish.yml"), "utf8"),
  );
  expect(publish.on.workflow_run.workflows).toEqual(["ci", "desktop-tauri"]);
  expect(publish.jobs.publish.if).toContain("head_repository.full_name == github.repository");
  expect(publish.jobs.publish.steps[0].with.ref).toBe("main");
  expect(publish.concurrency["cancel-in-progress"]).toBe(false);
});
