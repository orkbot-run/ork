// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")(
  "publishes only a complete stable release from a tested commit",
  () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const directory = mkdtempSync(path.join(os.tmpdir(), "tauri-stable-"));
    const revision = "a".repeat(40);
    const key = Buffer.from(
      `untrusted comment: fixture\n${Buffer.alloc(42).toString("base64")}\n`,
    ).toString("base64");
    try {
      writeFileSync(
        path.join(directory, "gh"),
        `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = process.env.FIXTURE_ROOT, args = process.argv.slice(2), revision = process.env.CANDIDATE_SHA;
const assets = () => JSON.parse(fs.readFileSync(path.join(root, 'assets.json'), 'utf8'));
if (args[0] === 'api') {
  const endpoint = args[1];
  if (endpoint.includes('/git/ref/tags/')) console.log(JSON.stringify({object:{type:'commit',sha:process.env.FIXTURE_BAD_TAG ? 'b'.repeat(40) : revision}}));
  else if (endpoint.endsWith('/releases/tags/' + process.env.TAURI_RELEASE_TAG)) console.log(JSON.stringify({tag_name:process.env.TAURI_RELEASE_TAG, draft:false, prerelease:process.env.TAURI_RELEASE_TAG.includes('-beta.'), assets:assets()}));
  else if (endpoint.includes('/ci.yml/runs?')) console.log(JSON.stringify({workflow_runs:process.env.FIXTURE_NO_CI ? [] : [{id:4,run_number:1,head_sha:revision,head_branch:'main',head_repository:{full_name:process.env.GITHUB_REPOSITORY},event:'push',conclusion:'success'}]}));
  else if (endpoint.endsWith('/releases/tags/desktop-beta') && process.env.FIXTURE_BETA_VERSION) console.log(JSON.stringify({assets:[{name:'latest.json',id:42}]}));
  else if (endpoint.endsWith('/releases/tags/desktop-preview') && process.env.FIXTURE_LEGACY_VERSION) console.log(JSON.stringify({assets:[{name:'latest.json',id:43}]}));
  else if (endpoint.endsWith('/releases/assets/42')) console.log(JSON.stringify({version:process.env.FIXTURE_BETA_VERSION}));
  else if (endpoint.endsWith('/releases/assets/43')) console.log(JSON.stringify({version:process.env.FIXTURE_LEGACY_VERSION}));
  else if (endpoint.endsWith('/releases/tags/desktop-stable') || endpoint.endsWith('/releases/tags/desktop-beta') || endpoint.endsWith('/releases/tags/desktop-preview')) { console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
  else process.exit(2);
} else if (args[0] === 'run' && args[1] === 'download') {
  const destination = args[args.indexOf('--dir') + 1];
  for (const platform of ['darwin-aarch64','darwin-x86_64','windows-x86_64','linux-x86_64']) {
    const folder = path.join(destination, 'ork-tauri-updater-' + platform); fs.mkdirSync(folder,{recursive:true});
    const archive = platform + '-archive'; fs.writeFileSync(path.join(folder, archive),'fixture');
    fs.writeFileSync(path.join(folder, platform + '.json'),JSON.stringify({platform,version:process.env.TAURI_RELEASE_TAG.slice(1),revision,key:process.env.TAURI_UPDATER_PUBLIC_KEY,archive,signature:'signature',files:[archive]}));
  }
} else if (args[0] === 'release' && args[1] === 'upload') {
  if (['desktop-stable', 'desktop-beta', 'desktop-preview'].includes(args[2])) { fs.copyFileSync(args[3], path.join(root,'promoted.json')); fs.appendFileSync(path.join(root,'channels.txt'), args[2]+'\\n'); }
  else { const current = assets(), file = args[3]; current.push({name:path.basename(file),size:fs.statSync(file).size,digest:'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}); fs.writeFileSync(path.join(root,'assets.json'),JSON.stringify(current)); }
} else if (!(args[0] === 'release' && args[1] === 'create')) process.exit(2);
`,
        { mode: 0o700 },
      );
      writeFileSync(path.join(directory, "assets.json"), "[]");
      const run = (extra: Record<string, string> = {}) =>
        execFileSync(
          process.execPath,
          [path.join(root, ".github/scripts/publish-tauri-release.mjs")],
          {
            env: {
              ...process.env,
              PATH: `${directory}${path.delimiter}${process.env.PATH}`,
              FIXTURE_ROOT: directory,
              GITHUB_REPOSITORY: "example/desktop",
              CANDIDATE_SHA: revision,
              GITHUB_RUN_ID: "4",
              TAURI_RELEASE_TAG: "v1.2.3",
              TAURI_UPDATER_PUBLIC_KEY: key,
              RUNNER_TEMP: directory,
              ...extra,
            },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      expect(() => run({ FIXTURE_NO_CI: "1" })).toThrow();
      expect(() => run({ FIXTURE_BAD_TAG: "1" })).toThrow();
      expect(run()).toContain("Published stable Ork 1.2.3");
      expect(readFileSync(path.join(directory, "channels.txt"), "utf8")).toBe(
        "desktop-stable\ndesktop-beta\ndesktop-preview\n",
      );
      expect(
        JSON.parse(readFileSync(path.join(directory, "promoted.json"), "utf8")).platforms[
          "darwin-aarch64"
        ].url,
      ).toContain("/v1.2.3/");
      writeFileSync(path.join(directory, "assets.json"), "[]");
      writeFileSync(path.join(directory, "channels.txt"), "");
      expect(run({ TAURI_RELEASE_TAG: "v1.3.0-beta.2" })).toContain(
        "Published beta Ork 1.3.0-beta.2",
      );
      expect(readFileSync(path.join(directory, "channels.txt"), "utf8")).toBe("desktop-beta\n");
      expect(
        JSON.parse(readFileSync(path.join(directory, "promoted.json"), "utf8")).platforms[
          "darwin-aarch64"
        ].url,
      ).toContain("/v1.3.0-beta.2/");
      writeFileSync(path.join(directory, "assets.json"), "[]");
      writeFileSync(path.join(directory, "channels.txt"), "");
      run({ FIXTURE_BETA_VERSION: "1.3.0-beta.2" });
      expect(readFileSync(path.join(directory, "channels.txt"), "utf8")).toBe(
        "desktop-stable\ndesktop-preview\n",
      );
      writeFileSync(path.join(directory, "assets.json"), "[]");
      writeFileSync(path.join(directory, "channels.txt"), "");
      run({ FIXTURE_LEGACY_VERSION: "1.3.0" });
      expect(readFileSync(path.join(directory, "channels.txt"), "utf8")).toBe(
        "desktop-stable\ndesktop-beta\n",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
