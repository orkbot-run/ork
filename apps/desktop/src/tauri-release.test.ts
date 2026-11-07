// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLATFORMS,
  previewVersion,
  releaseConfiguration,
  releaseManifest,
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

  it("assigns increasing versions that native installers accept and preserves retry versions", () => {
    expect(previewVersion("42")).toBe("1.1.42");
    expect(previewVersion("65535")).toBe("1.2.0");
    expect(previewVersion("65534")).toBe("1.1.65534");
    for (const value of ["", "-1", "1;echo bad", "1.2", "0", "16645890"])
      expect(() => previewVersion(value)).toThrow();
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
    writeFileSync(path.join(bundle, "Ork Preview.app.tar.gz"), "fixture archive");
    expect(() =>
      stageArtifacts(bundle, output, {
        platform: "darwin-aarch64",
        version: options.version,
        revision,
        key,
      }),
    ).toThrow();
    writeFileSync(path.join(bundle, "Ork Preview.app.tar.gz.sig"), "signature\n");
    const staged = stageArtifacts(bundle, output, {
      platform: "darwin-aarch64",
      version: options.version,
      revision,
      key,
    });
    expect(staged.archive).toBe("darwin-aarch64-Ork_Preview.app.tar.gz");
    expect(readFileSync(path.join(output, staged.archive), "utf8")).toBe("fixture archive");
    expect(staged.signature).toBe("signature");
  });
  it("promotes only a complete same-revision, same-key release with immutable HTTPS URLs", () => {
    const manifest = releaseManifest(entries(), options);
    expect(Object.keys(manifest.platforms)).toEqual([...PLATFORMS]);
    expect(manifest.platforms["darwin-aarch64"]?.url).toBe(
      "https://github.com/example/desktop/releases/download/desktop-preview-1.1.42/darwin-aarch64-app.tar.gz",
    );
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

it.skipIf(process.platform === "win32")(
  "runs the publication pipeline offline and withholds promotion after a failed CI",
  async () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const directory = temporary();
    const context = {
      repository: options.repository,
      revision,
      key,
      ciSuccess: true,
      channelDraft: true,
    };
    writeFileSync(path.join(directory, "context.json"), JSON.stringify(context));
    writeFileSync(
      path.join(directory, "gh"),
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FIXTURE_ROOT;
const context = JSON.parse(fs.readFileSync(path.join(root,'context.json'),'utf8'));
const args = process.argv.slice(2);
const read = () => JSON.parse(fs.readFileSync(path.join(root,'assets.json'),'utf8'));
fs.appendFileSync(path.join(root,'calls.jsonl'), JSON.stringify(args)+'\\n');
if(args[0] === 'api') {
  const endpoint = args[1];
  if(endpoint.endsWith('/git/ref/heads/main')) console.log(JSON.stringify({object:{sha:context.revision}}));
  else if(endpoint.includes('/releases?')) console.log(JSON.stringify({count:1,match:context.channelDraft && args[args.indexOf('--jq')+1].includes('"desktop-preview"') ? {id:77,tag_name:'desktop-preview',draft:true,assets:[{id:88,name:'latest.json',browser_download_url:'https://example.invalid/draft.json'}]} : null}));
  else if(endpoint.endsWith('/releases/assets/88')) { if(!args.includes('Accept: application/octet-stream')) process.exit(3); console.log(JSON.stringify({version:'1.1.41'})); }
  else if(endpoint.includes('/runs?')) {
    const success = !endpoint.includes('/ci.yml/') || context.ciSuccess;
    console.log(JSON.stringify({workflow_runs: success ? [{id:123,run_number:42,head_sha:context.revision,head_branch:'main',head_repository:{full_name:context.repository},event:'push',conclusion:'success'}] : []}));
  } else if(endpoint.includes('/releases/tags/')) {
    if(endpoint.endsWith('/desktop-preview') || !fs.existsSync(path.join(root,'assets.json'))) { console.error('gh: Not Found (HTTP 404)');process.exit(1); }
    console.log(JSON.stringify({assets:read(),target_commitish:context.revision,prerelease:true,draft:context.withdrawn===true}));
  }
  else process.exit(2);
} else if(args[0] === 'run' && args[1] === 'download') {
  const destination=args[args.indexOf('--dir')+1];
  for(const platform of ['darwin-aarch64','darwin-x86_64','windows-x86_64','linux-x86_64']) {
    const folder=path.join(destination,'ork-tauri-updater-'+platform);
    fs.mkdirSync(folder,{recursive:true});
    const archive=platform+'-app.tar.gz';
    fs.writeFileSync(path.join(folder,archive),'fixture artifact');
    fs.writeFileSync(path.join(folder,platform+'.json'),JSON.stringify({platform,version:'1.1.42',revision:context.revision,key:context.key,archive,signature:'fixture signature',files:[archive]}));
  }
} else if(args[0] === 'release' && args[1] === 'create') {
  if(args[2] !== 'desktop-preview') fs.writeFileSync(path.join(root,'assets.json'),'[]');
} else if(args[0] === 'release' && args[1] === 'upload') {
  if(args[2] === 'desktop-preview') fs.copyFileSync(args[3],path.join(root,'promoted.json'));
  else { const assets=read(); assets.push({name:path.basename(args[3]),size:fs.statSync(args[3]).size,digest:'sha256:'+require('node:crypto').createHash('sha256').update(fs.readFileSync(args[3])).digest('hex')});fs.writeFileSync(path.join(root,'assets.json'),JSON.stringify(assets)); }
} else if(args[0] === 'release' && args[1] === 'edit') {}
else if(args[0] === 'release' && args[1] === 'view') console.log(JSON.stringify({assets:read(),target_commitish:context.revision,prerelease:true,draft:context.withdrawn===true}));
else process.exit(2);
`,
      { mode: 0o700 },
    );
    const run = () =>
      execFileSync(process.execPath, [path.join(root, ".github/scripts/publish-tauri.mjs")], {
        env: {
          ...process.env,
          PATH: `${directory}${path.delimiter}${process.env.PATH}`,
          GITHUB_REPOSITORY: options.repository,
          CANDIDATE_SHA: revision,
          RUNNER_TEMP: directory,
          TAURI_UPDATER_PUBLIC_KEY: key,
          FIXTURE_ROOT: directory,
        },
        encoding: "utf8",
      });
    expect(run()).toContain("Published Ork Preview 1.1.42");
    expect(
      JSON.parse(readFileSync(path.join(directory, "promoted.json"), "utf8")).platforms,
    ).toHaveProperty("darwin-aarch64");
    rmSync(path.join(directory, "promoted.json"));
    writeFileSync(
      path.join(directory, "context.json"),
      JSON.stringify({ ...context, ciSuccess: false }),
    );
    expect(run()).toContain("waits for successful CI");
    expect(() => readFileSync(path.join(directory, "promoted.json"))).toThrow();
    const calls = readFileSync(path.join(directory, "calls.jsonl"), "utf8");
    expect(calls).toContain("Accept: application/octet-stream");
    expect(calls).toContain("--draft=false");
    writeFileSync(
      path.join(directory, "context.json"),
      JSON.stringify({ ...context, withdrawn: true }),
    );
    expect(() => run()).toThrow("Desktop version is withdrawn");
  },
);
