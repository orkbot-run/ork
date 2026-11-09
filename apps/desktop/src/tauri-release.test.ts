// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareReleaseVersions,
  PLATFORMS,
  releaseConfiguration,
  releaseManifest,
  releaseVersion,
  stableReleaseVersion,
  stageArtifacts,
  verifiedBuild,
} from "../scripts/tauri-release.js";

const key = Buffer.from(
  `untrusted comment: fixture\n${Buffer.alloc(42).toString("base64")}\n`,
).toString("base64");
const revision = "a".repeat(40);
const options = {
  repository: "example/desktop",
  version: "1.1.42",
  releaseTag: "v1.1.42",
  revision,
  key,
  date: "2026-01-01T00:00:00Z",
};
const entries = () =>
  PLATFORMS.map((platform) => ({
    platform,
    ...options,
    archive: `${platform}-app.tar.gz`,
    signature: "fixture-signature",
    files: [`${platform}-app.tar.gz`],
  }));
const directories: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "tauri-release-test-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("signed desktop releases", () => {
  it("accepts only bounded stable release tags", () => {
    expect(stableReleaseVersion("v2.3.4")).toBe("2.3.4");
    for (const tag of ["v1.0.0-beta.1", "v01.2.3", "latest", "v1.2.65536"])
      expect(() => stableReleaseVersion(tag)).toThrow();
  });
  it("accepts only numbered beta releases", () => {
    expect(releaseVersion("v2.3.4-beta.7")).toBe("2.3.4-beta.7");
    for (const tag of ["v2.3.4-beta", "v2.3.4-beta.0", "v2.3.4-rc.1", "v2.3.4-beta.01"])
      expect(() => releaseVersion(tag)).toThrow();
    expect(releaseConfiguration("2.3.4-beta.7", key).version).toBe("2.3.4-beta.7");
  });
  it("orders stable releases above their beta and protects newer beta builds", () => {
    expect(compareReleaseVersions("1.2.0", "1.2.0-beta.9")).toBe(1);
    expect(compareReleaseVersions("1.2.1-beta.1", "1.2.0")).toBe(1);
    expect(compareReleaseVersions("1.2.1-beta.9", "1.2.1-beta.10")).toBe(-1);
    expect(compareReleaseVersions("1.2.0", "1.2.0")).toBe(0);
    expect(() => compareReleaseVersions("preview", "1.2.0")).toThrow();
  });
  it("keeps the beta version for the updater and uses numeric macOS bundle metadata", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const output = path.join(temporary(), "release.json");
    execFileSync(process.execPath, ["apps/desktop/scripts/tauri-release.ts", "prepare", output], {
      cwd: root,
      env: { ...process.env, TAURI_RELEASE_TAG: "v2.3.4-beta.7", TAURI_UPDATER_PUBLIC_KEY: key },
    });
    const config = JSON.parse(readFileSync(output, "utf8"));
    expect(config.version).toBe("2.3.4-beta.7");
    expect(config.bundle.macOS.bundleVersion).toBe("2.3.4");
    const plist = readFileSync(config.bundle.macOS.infoPlist, "utf8");
    expect(plist).toContain("<key>CFBundleShortVersionString</key><string>2.3.4</string>");
    expect(plist).toContain("NSMicrophoneUsageDescription");
  });
  it("accepts only successful same-revision main builds from the publishing repository", () => {
    const run = {
      id: 1,
      run_number: 42,
      head_sha: revision,
      head_branch: "main",
      head_repository: { full_name: options.repository },
      event: "push",
      conclusion: "success",
    };
    const context = { repository: options.repository, revision, events: ["push"] };
    expect(verifiedBuild([run], context)?.id).toBe(1);
    for (const patch of [
      { head_sha: "b".repeat(40) },
      { head_branch: "feature" },
      { head_repository: { full_name: "fork/desktop" } },
      { event: "pull_request" },
      { conclusion: "failure" },
      { conclusion: "cancelled" },
    ]) {
      expect(verifiedBuild([{ ...run, ...patch }], context)).toBeUndefined();
    }
    expect(verifiedBuild([run, { ...run, id: 2, run_number: 43 }], context)?.id).toBe(2);
  });

  it("requires the updater verification key and version-bound signed artifacts", () => {
    expect(releaseConfiguration("1.1.42", key)).toMatchObject({
      bundle: { createUpdaterArtifacts: true },
      plugins: { updater: { pubkey: key, requireSignedVersion: true } },
    });
    expect(() => releaseConfiguration("1.1.42", "invalid")).toThrow();
  });
  it("stages a signed updater with a platform-qualified name and refuses unsigned output", () => {
    const bundle = temporary();
    const output = temporary();
    writeFileSync(path.join(bundle, "Ork.app.tar.gz"), "fixture archive");
    expect(() =>
      stageArtifacts(bundle, output, {
        platform: "darwin-aarch64",
        version: options.version,
        revision,
        key,
      }),
    ).toThrow();
    writeFileSync(path.join(bundle, "Ork.app.tar.gz.sig"), "signature\n");
    const staged = stageArtifacts(bundle, output, {
      platform: "darwin-aarch64",
      version: options.version,
      revision,
      key,
    });
    expect(staged.archive).toBe("darwin-aarch64-Ork.app.tar.gz");
    expect(readFileSync(path.join(output, staged.archive), "utf8")).toBe("fixture archive");
    expect(staged.signature).toBe("signature");
  });
  it("promotes only a complete same-revision, same-key release with immutable HTTPS URLs", () => {
    const manifest = releaseManifest(entries(), options);
    expect(manifest.notes).toBe("Ork");
    expect(Object.keys(manifest.platforms)).toEqual([...PLATFORMS]);
    expect(manifest.platforms["darwin-aarch64"]?.url).toBe(
      "https://github.com/example/desktop/releases/download/v1.1.42/darwin-aarch64-app.tar.gz",
    );
    expect(
      releaseManifest(entries(), { ...options, releaseTag: "v1.1.42" }).platforms["darwin-aarch64"]
        ?.url,
    ).toBe(
      "https://github.com/example/desktop/releases/download/v1.1.42/darwin-aarch64-app.tar.gz",
    );
    expect(() => releaseManifest(entries(), { ...options, releaseTag: "v1.1.41" })).toThrow();
    expect(() => releaseManifest(entries().slice(1), options)).toThrow();
    for (const patch of [
      { revision: "b".repeat(40) },
      { version: "1.1.41" },
      { key: "other-key" },
      { archive: "../escape" },
      { platform: "darwin-x86_64" },
    ]) {
      const mismatched = entries();
      Object.assign(mismatched[0]!, patch);
      expect(() => releaseManifest(mismatched, options)).toThrow();
    }
  });
});
