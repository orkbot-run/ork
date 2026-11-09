// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLATFORMS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "windows-x86_64",
  "linux-x86_64",
] as const;
const MAX_BYTES = 256 * 1024 * 1024;

/** A stable desktop build uses the version of its published source release. */
export function stableReleaseVersion(tag: string) {
  const match = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(tag);
  if (!match || match.slice(1).some((part) => Number(part) > 65535))
    throw new Error("Invalid stable desktop release tag.");
  return tag.slice(1);
}

export function releaseVersion(tag: string) {
  const beta =
    /^(v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))-beta\.([1-9][0-9]*)$/.exec(tag);
  if (!beta) return stableReleaseVersion(tag);
  stableReleaseVersion(beta[1]!);
  if (!Number.isSafeInteger(Number(beta[2]))) throw new Error("Invalid beta release tag.");
  return tag.slice(1);
}

export function compareReleaseVersions(left: string, right: string) {
  releaseVersion(`v${left}`);
  releaseVersion(`v${right}`);
  const [leftBase, leftBeta] = left.split("-beta.");
  const [rightBase, rightBeta] = right.split("-beta.");
  const leftParts = leftBase!.split(".").map(Number);
  const rightParts = rightBase!.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (leftParts[index] !== rightParts[index])
      return leftParts[index]! < rightParts[index]! ? -1 : 1;
  }
  if (leftBeta === rightBeta) return 0;
  if (leftBeta === undefined) return 1;
  if (rightBeta === undefined) return -1;
  return Number(leftBeta) < Number(rightBeta) ? -1 : 1;
}

/** A workflow run keeps its version across retries and stays within native installer limits. */
export function previewVersion(run: string) {
  if (!/^[1-9][0-9]*$/.test(run)) throw new Error("Invalid desktop build number.");
  const number = Number(run);
  if (!Number.isSafeInteger(number) || number >= 254 * 65535)
    throw new Error("Desktop build number exceeds installer limits.");
  return `1.${1 + Math.floor(number / 65535)}.${number % 65535}`;
}

export function releaseConfiguration(version: string, key: string) {
  releaseVersion(`v${version}`);
  const decoded = Buffer.from(key, "base64").toString("utf8");
  const packet = Buffer.from(decoded.trim().split("\n").at(-1) ?? "", "base64");
  if (!decoded.startsWith("untrusted comment:") || packet.length !== 42)
    throw new Error("A Tauri updater public key is required.");
  return {
    version,
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { pubkey: key, requireSignedVersion: true } },
  };
}

interface WorkflowRun {
  id: number;
  run_number: number;
  head_sha: string;
  head_branch: string;
  head_repository: { full_name: string };
  event: string;
  conclusion: string;
}

/** A successful unrelated revision, pull request or fork cannot authorize publication. */
export function verifiedBuild(
  runs: WorkflowRun[],
  context: { repository: string; revision: string; events: string[] },
) {
  return runs
    .filter(
      (run) =>
        run.head_sha === context.revision &&
        run.head_branch === "main" &&
        run.head_repository.full_name === context.repository &&
        context.events.includes(run.event) &&
        run.conclusion === "success",
    )
    .sort((a, b) => b.run_number - a.run_number)[0];
}

interface PlatformArtifact {
  platform: string;
  version: string;
  revision: string;
  key: string;
  archive: string;
  signature: string;
  files: string[];
}

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(file) : entry.isFile() ? [file] : [];
  });
}

export function stageArtifacts(
  bundle: string,
  output: string,
  metadata: Pick<PlatformArtifact, "platform" | "version" | "revision" | "key">,
) {
  if (!(PLATFORMS as readonly string[]).includes(metadata.platform))
    throw new Error("Unsupported desktop platform.");
  const files = filesBelow(bundle);
  const suffix = metadata.platform.startsWith("darwin")
    ? ".app.tar.gz"
    : metadata.platform.startsWith("windows")
      ? ".exe"
      : ".AppImage";
  const archives = files.filter((file) => file.endsWith(suffix) && files.includes(`${file}.sig`));
  if (archives.length !== 1) throw new Error("Exactly one signed updater artifact is required.");
  const archive = archives[0]!;
  const size = statSync(archive).size;
  if (size === 0 || size > MAX_BYTES)
    throw new Error("Desktop update exceeds the client download limit.");
  const signature = readFileSync(`${archive}.sig`, "utf8").trim();
  if (!signature || signature.length > 8192) throw new Error("Missing desktop update signature.");
  mkdirSync(output, { recursive: true });
  const shipped = files.filter(
    (file) =>
      file === archive ||
      file === `${archive}.sig` ||
      (metadata.platform.startsWith("darwin") && file.endsWith(".dmg")),
  );
  const names = shipped.map(
    (file) => `${metadata.platform}-${path.basename(file).replaceAll(" ", "_")}`,
  );
  if (new Set(names).size !== names.length) throw new Error("Duplicate desktop release asset.");
  shipped.forEach((file, index) => {
    copyFileSync(file, path.join(output, names[index]!));
  });
  const result: PlatformArtifact = {
    ...metadata,
    archive: names[shipped.indexOf(archive)]!,
    signature,
    files: names,
  };
  writeFileSync(path.join(output, `${metadata.platform}.json`), `${JSON.stringify(result)}\n`);
  return result;
}

/** Platform archives have immutable URLs; only the complete channel manifest is replaced. */
export function releaseManifest(
  entries: PlatformArtifact[],
  options: {
    repository: string;
    version: string;
    revision: string;
    key: string;
    date: string;
    releaseTag?: string;
  },
) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository) ||
    !/^[a-f0-9]{40}$/.test(options.revision)
  )
    throw new Error("Invalid release provenance.");
  releaseConfiguration(options.version, options.key);
  if (options.releaseTag && releaseVersion(options.releaseTag) !== options.version)
    throw new Error("Desktop tag does not match its version.");
  if (
    entries.length !== PLATFORMS.length ||
    new Set(entries.map((entry) => entry.platform)).size !== PLATFORMS.length
  )
    throw new Error("Every desktop platform must succeed before publication.");
  const platforms: Record<string, { signature: string; url: string }> = {};
  for (const entry of entries) {
    if (
      !(PLATFORMS as readonly string[]).includes(entry.platform) ||
      entry.version !== options.version ||
      entry.revision !== options.revision ||
      entry.key !== options.key ||
      !entry.signature ||
      entry.signature.length > 8192 ||
      !entry.files.includes(entry.archive) ||
      entry.files.some((file) => !/^[A-Za-z0-9_.-]+$/.test(file) || file === "." || file === "..")
    )
      throw new Error("Desktop artifact provenance does not match this release.");
    platforms[entry.platform] = {
      signature: entry.signature,
      url: `https://github.com/${options.repository}/releases/download/${options.releaseTag ?? `desktop-preview-${options.version}`}/${entry.archive}`,
    };
  }
  if (!Number.isFinite(Date.parse(options.date))) throw new Error("Invalid publication date.");
  return { version: options.version, notes: "Ork", pub_date: options.date, platforms };
}

function main() {
  const [command, input, output] = process.argv.slice(2);
  const version = process.env.TAURI_RELEASE_TAG
    ? releaseVersion(process.env.TAURI_RELEASE_TAG)
    : previewVersion(process.env.GITHUB_RUN_NUMBER ?? "");
  const key = process.env.TAURI_UPDATER_PUBLIC_KEY ?? "";
  if (command === "prepare" && input) {
    const config = releaseConfiguration(version, key);
    if (version.includes("-beta.")) {
      const numeric = version.split("-")[0]!;
      const plist = readFileSync("apps/desktop/src-tauri/Info.plist", "utf8").replace(
        "</dict>",
        `<key>CFBundleShortVersionString</key><string>${numeric}</string></dict>`,
      );
      const plistPath = `${input}.plist`;
      writeFileSync(plistPath, plist);
      Object.assign(config.bundle, { macOS: { bundleVersion: numeric, infoPlist: plistPath } });
    }
    writeFileSync(input, JSON.stringify(config));
  } else if (command === "stage" && input && output) {
    stageArtifacts(input, output, {
      platform: process.env.TAURI_RELEASE_PLATFORM ?? "",
      version,
      revision: process.env.GITHUB_SHA ?? "",
      key,
    });
  } else {
    throw new Error("Invalid desktop release arguments.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
