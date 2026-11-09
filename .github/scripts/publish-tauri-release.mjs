// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Standalone CI publication is not a Turbo task.
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  compareReleaseVersions,
  PLATFORMS,
  releaseManifest,
  releaseVersion,
  verifiedBuild,
} from "../../apps/desktop/scripts/tauri-release.ts";

const repository = process.env.GITHUB_REPOSITORY ?? "";
const revision = process.env.CANDIDATE_SHA ?? "";
const tag = process.env.TAURI_RELEASE_TAG ?? "";
const runId = process.env.GITHUB_RUN_ID ?? "";
const version = releaseVersion(tag);
const beta = version.includes("-beta.");
if (
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
  !/^[a-f0-9]{40}$/.test(revision) ||
  !/^[1-9][0-9]*$/.test(runId)
)
  throw new Error("Invalid desktop release context.");
const api = (endpoint) =>
  JSON.parse(
    execFileSync("gh", ["api", `repos/${repository}/${endpoint}`], {
      encoding: "utf8",
      timeout: 30000,
    }),
  );
const gh = (...args) =>
  execFileSync("gh", [...args, "--repo", repository], { encoding: "utf8", timeout: 120000 });
const digest = (file) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;

function tagCommit() {
  let object = api(`git/ref/tags/${tag}`).object;
  for (let depth = 0; object.type === "tag" && depth < 5; depth++)
    object = api(`git/tags/${object.sha}`).object;
  if (object.type !== "commit" || object.sha !== revision)
    throw new Error("The release tag no longer identifies the built commit.");
}

function currentRelease() {
  const release = api(`releases/tags/${tag}`);
  if (release.tag_name !== tag || release.draft || release.prerelease !== beta)
    throw new Error("The desktop release is unavailable or was withdrawn.");
  return release;
}

function channelRelease(channelTag) {
  const result = spawnSync("gh", ["api", `repos/${repository}/releases/tags/${channelTag}`], {
    encoding: "utf8",
    timeout: 30000,
  });
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/\(HTTP 404\)/.test(result.stderr)) return null;
  throw new Error("Could not resolve the stable desktop channel.");
}

tagCommit();
currentRelease();
const runs = api(
  `actions/workflows/ci.yml/runs?head_sha=${revision}&status=success&per_page=100`,
).workflow_runs;
if (!verifiedBuild(runs, { repository, revision, events: ["push"] }))
  throw new Error("A successful main CI run for this exact release commit is required.");
const temporary = mkdtempSync(path.join(process.env.RUNNER_TEMP, "tauri-stable-"));
const artifacts = path.join(temporary, "artifacts");
gh("run", "download", runId, "--pattern", "ork-tauri-updater-*", "--dir", artifacts);
const entries = PLATFORMS.map((platform) =>
  JSON.parse(
    readFileSync(path.join(artifacts, `ork-tauri-updater-${platform}`, `${platform}.json`), "utf8"),
  ),
);
const manifest = releaseManifest(entries, {
  repository,
  revision,
  version,
  releaseTag: tag,
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
const previous = currentRelease().assets;
for (const file of assets) {
  const existing = previous.find((asset) => asset.name === path.basename(file));
  if (existing && (existing.size !== statSync(file).size || existing.digest !== digest(file)))
    throw new Error("An immutable desktop asset has changed.");
  if (!existing) gh("release", "upload", tag, file);
}
const uploaded = currentRelease().assets;
if (
  !assets.every((file) =>
    uploaded.some(
      (asset) =>
        asset.name === path.basename(file) &&
        asset.size === statSync(file).size &&
        asset.digest === digest(file),
    ),
  )
)
  throw new Error("The desktop release upload is incomplete.");
function promote(channelTag) {
  tagCommit();
  currentRelease();
  const channel = channelRelease(channelTag);
  if (channel) {
    const asset = channel.assets.find((item) => item.name === "latest.json");
    if (asset) {
      const old = JSON.parse(
        execFileSync(
          "gh",
          [
            "api",
            `repos/${repository}/releases/assets/${asset.id}`,
            "-H",
            "Accept: application/octet-stream",
          ],
          { encoding: "utf8", timeout: 30000 },
        ),
      );
      if (compareReleaseVersions(old.version, version) > 0) return;
    }
  } else {
    gh(
      "release",
      "create",
      channelTag,
      "--target",
      revision,
      "--prerelease",
      "--latest=false",
      "--title",
      channelTag === "desktop-beta" ? "Ork beta updates" : "Ork stable updates",
      "--notes",
      channelTag === "desktop-beta"
        ? "Beta desktop update channel."
        : "Stable desktop update channel.",
    );
  }
  const output = path.join(temporary, "latest.json");
  writeFileSync(output, `${JSON.stringify(manifest)}\n`);
  tagCommit();
  currentRelease();
  gh("release", "upload", channelTag, output, "--clobber");
}
if (!beta) promote("desktop-stable");
promote("desktop-beta");
console.log(
  `Published ${beta ? "beta" : "stable"} Ork ${version} for ${entries.length} platforms.`,
);
