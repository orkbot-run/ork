// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Standalone CI publication is not a Turbo task.
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  PLATFORMS,
  previewVersion,
  releaseManifest,
  verifiedBuild,
} from "../../apps/desktop/scripts/tauri-release.ts";

const repository = process.env.GITHUB_REPOSITORY;
const revision = process.env.CANDIDATE_SHA;
if (
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
  !/^[a-f0-9]{40}$/.test(revision ?? "")
)
  throw new Error("Invalid desktop publication context.");
const gh = (...args) =>
  execFileSync("gh", [...args, "--repo", repository], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
const api = (endpoint) =>
  JSON.parse(
    execFileSync("gh", ["api", `repos/${repository}/${endpoint}`], {
      encoding: "utf8",
      timeout: 30_000,
    }),
  );
const release = (tag) => {
  const result = spawnSync("gh", ["api", `repos/${repository}/releases/tags/${tag}`], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status === 0) return JSON.parse(result.stdout);
  if (result.status !== null && /\(HTTP 404\)/.test(result.stderr)) return null;
  throw new Error("Could not resolve the desktop release.");
};
const digest = (file) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
const current = () => api("git/ref/heads/main").object.sha === revision;
const successful = (workflow, events) =>
  verifiedBuild(
    api(`actions/workflows/${workflow}/runs?head_sha=${revision}&status=success&per_page=100`)
      .workflow_runs,
    { repository, revision, events },
  );

async function publish() {
  if (!current()) return console.log("Desktop publication skipped: main has advanced.");
  const ci = successful("ci.yml", ["push"]);
  const desktop = successful("desktop-tauri.yml", ["push", "workflow_dispatch"]);
  if (!ci || !desktop)
    return console.log(
      "Desktop publication waits for successful CI and all native builds of the same revision.",
    );
  const version = previewVersion(String(desktop.run_number));
  const temporary = mkdtempSync(path.join(process.env.RUNNER_TEMP, "tauri-publish-"));
  const artifacts = path.join(temporary, "artifacts");
  gh("run", "download", String(desktop.id), "--pattern", "ork-tauri-updater-*", "--dir", artifacts);
  const entries = PLATFORMS.map((platform) =>
    JSON.parse(
      readFileSync(
        path.join(artifacts, `ork-tauri-updater-${platform}`, `${platform}.json`),
        "utf8",
      ),
    ),
  );
  const manifest = releaseManifest(entries, {
    repository,
    revision,
    version,
    key: process.env.TAURI_UPDATER_PUBLIC_KEY,
    date: new Date().toISOString(),
  });
  const assets = entries.flatMap((entry) =>
    entry.files.map((file) => path.join(artifacts, `ork-tauri-updater-${entry.platform}`, file)),
  );
  for (const file of assets) {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > 256 * 1024 * 1024)
      throw new Error("Invalid desktop release asset.");
  }
  const tag = `desktop-preview-${version}`;
  const existing = release(tag);
  if (existing && (existing.target_commitish !== revision || !existing.prerelease))
    throw new Error("Desktop version is already assigned to another release.");
  if (!current()) return console.log("Desktop publication skipped: main has advanced.");
  if (!existing)
    gh(
      "release",
      "create",
      tag,
      "--target",
      revision,
      "--prerelease",
      "--latest=false",
      "--title",
      `Ork Preview ${version}`,
      "--notes",
      "Automated Preview build from main.",
    );
  // Reruns reuse existing immutable assets and only fill an interrupted upload.
  const uploaded = existing?.assets ?? [];
  for (const file of assets) {
    const asset = uploaded.find((asset) => asset.name === path.basename(file));
    if (asset && (asset.size !== statSync(file).size || asset.digest !== digest(file)))
      throw new Error("An immutable desktop asset has changed.");
    if (!asset) gh("release", "upload", tag, file);
  }
  const verified = release(tag).assets;
  if (
    !assets.every((file) =>
      verified.some(
        (asset) =>
          asset.name === path.basename(file) &&
          asset.size === statSync(file).size &&
          asset.digest === digest(file),
      ),
    )
  )
    throw new Error("The desktop release upload is incomplete.");
  if (!current())
    return console.log(
      "Desktop artifacts published; channel promotion skipped because main advanced.",
    );
  const channel = release("desktop-preview");
  if (channel) {
    const channelAsset = channel.assets.find((asset) => asset.name === "latest.json");
    if (channelAsset) {
      const response = await fetch(channelAsset.browser_download_url, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("Cannot read the current desktop channel.");
      const previous = await response.json();
      const compare = (value) => value.split(".").map(Number);
      const before = compare(previous.version);
      const next = compare(version);
      if (before.some((value) => !Number.isSafeInteger(value)) || before.length !== 3)
        throw new Error("Invalid current desktop channel version.");
      for (let i = 0; i < 3; i++) {
        if (before[i] > next[i]) return console.log("Desktop channel already has a newer version.");
        if (before[i] < next[i]) break;
      }
    }
  } else {
    gh(
      "release",
      "create",
      "desktop-preview",
      "--target",
      revision,
      "--prerelease",
      "--latest=false",
      "--title",
      "Ork Preview",
      "--notes",
      "Automatic desktop updates from verified main builds.",
    );
  }
  const output = path.join(temporary, "latest.json");
  writeFileSync(output, `${JSON.stringify(manifest)}\n`);
  if (!current()) return console.log("Desktop channel promotion skipped: main has advanced.");
  gh("release", "upload", "desktop-preview", output, "--clobber");
  console.log(`Published Ork Preview ${version} for ${entries.length} platforms.`);
}

await publish();
