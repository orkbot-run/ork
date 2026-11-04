// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkLicenseHeaders } from "./license-headers.mjs";

const APACHE = "Apache baseline text\n";
const POLYFORM = "PolyForm-Noncommercial-1.0.0";
const header = (license = POLYFORM) =>
  `// SPDX-License-Identifier: ${license}\n// SPDX-FileCopyrightText: 2026 Example contributors\n`;
const sidecar = (license = POLYFORM) =>
  `SPDX-FileCopyrightText: 2026 Example contributors\nSPDX-License-Identifier: ${license}\n`;

function repository(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "ork-license-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Test contributor");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  const write = (file, content) => writeFileSync(path.join(cwd, file), content);
  write("LICENSE", APACHE);
  write("inherited.ts", "export const inherited = true;\n");
  write(".gitignore", "ignored.txt\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "baseline");
  const base = git("rev-parse", "HEAD");
  return { cwd, base, git, write, check: () => checkLicenseHeaders({ cwd, base }) };
}

test("checks staged and untracked new files while preserving the inherited scope", (t) => {
  const repo = repository(t);
  repo.write("inherited.ts", "export const inherited = false;\n");
  repo.write("ignored.txt", "ignored generated data");
  repo.write("new file.ts", "export const missing = true;\n");
  repo.write("staged.ts", "export const missing = true;\n");
  repo.git("add", "staged.ts");
  assert.deepEqual(repo.check(), {
    added: 2,
    errors: ["new file.ts", "staged.ts"].map(
      (file) => `${file}: add an SPDX header or a .license sidecar with copyright attribution.`,
    ),
  });
});

test("accepts source headers, imported licenses, and sidecars for JSON and binary files", (t) => {
  const repo = repository(t);
  repo.write("own.ts", `${header()}export const own = true;\n`);
  repo.write("imported.ts", `${header("Apache-2.0")}export const imported = true;\n`);
  repo.write("vendor.ts", `${header("MIT")}export const vendor = true;\n`);
  repo.write("mixed.ts", header("(Apache-2.0 AND PolyForm-Noncommercial-1.0.0)"));
  repo.write("config.json", "{}\n");
  repo.write("config.json.license", sidecar());
  repo.write("asset.bin", Buffer.from([0, 1, 2]));
  repo.write("asset.bin.license", sidecar("Apache-2.0"));
  repo.write("LICENSE-POLYFORM", "Complete license text\n");
  repo.write("NOTICE", "Complete attribution notice\n");
  assert.deepEqual(repo.check().errors, []);
});

test("recognizes Markdown, shell, XML, Astro, and block comment headers", (t) => {
  const repo = repository(t);
  repo.write(
    "guide.md",
    `<!-- SPDX-License-Identifier: ${POLYFORM} -->\n<!-- SPDX-FileCopyrightText: 2026 Example contributors -->\n# Guide\n`,
  );
  repo.write(
    "tool.sh",
    `#!/bin/sh\n# SPDX-License-Identifier: ${POLYFORM}\n# SPDX-FileCopyrightText: 2026 Example contributors\necho ready\n`,
  );
  repo.write(
    "style.css",
    `/* SPDX-License-Identifier: ${POLYFORM} */\n/* SPDX-FileCopyrightText: 2026 Example contributors */\nbody {}\n`,
  );
  repo.write("page.astro", `---\n${header()}---\n<p>Example</p>\n`);
  repo.write(
    "asset.svg",
    `<?xml version="1.0"?>\n<!-- SPDX-License-Identifier: MIT -->\n<!-- SPDX-FileCopyrightText: 2026 Example contributors -->\n<svg/>\n`,
  );
  assert.deepEqual(repo.check().errors, []);
});

test("recognizes HTML notices with standard and alternate comment endings", (t) => {
  const repo = repository(t);
  for (const [name, ending] of [
    ["standard", "-->"],
    ["alternate", "--!>"],
  ]) {
    repo.write(
      `${name}-single.html`,
      `<!-- SPDX-License-Identifier: ${POLYFORM} ${ending}\n<!-- SPDX-FileCopyrightText: 2026 Example contributors ${ending}\n<p>Example</p>\n`,
    );
    repo.write(
      `${name}-multiline.html`,
      `<!--\n * SPDX-License-Identifier: ${POLYFORM}\n * SPDX-FileCopyrightText: 2026 Example contributors\n${ending}\n<p>Example</p>\n`,
    );
  }
  assert.deepEqual(repo.check().errors, []);
});

test("requires source copyright attribution in the header or a matching sidecar", (t) => {
  const repo = repository(t);
  repo.write("own.ts", `// SPDX-License-Identifier: ${POLYFORM}\nexport const own = true;\n`);
  repo.write(
    "vendor.ts",
    '// SPDX-License-Identifier: MIT\nconst copyright = "SPDX-FileCopyrightText: 2026 Example contributors";\n',
  );
  assert.deepEqual(
    repo.check().errors,
    ["own.ts", "vendor.ts"].map(
      (file) => `${file}: include SPDX-FileCopyrightText in the header or .license sidecar.`,
    ),
  );
  repo.write("own.ts", `${header()}export const own = true;\n`);
  repo.write("vendor.ts.license", sidecar("MIT"));
  assert.deepEqual(repo.check().errors, []);
});

test("rejects SPDX strings in code and incomplete sidecar attribution", (t) => {
  const repo = repository(t);
  repo.write("fake.ts", `const text = "SPDX-License-Identifier: ${POLYFORM}";\n${header()}`);
  repo.write("config.json", "{}\n");
  repo.write("config.json.license", `SPDX-License-Identifier: ${POLYFORM}\n`);
  const errors = repo.check().errors;
  assert.equal(errors.length, 3);
  assert.ok(errors.some((error) => error.startsWith("fake.ts:")));
  assert.ok(errors.some((error) => error.startsWith("config.json:")));
  assert.ok(errors.some((error) => error.startsWith("config.json.license:")));
});

test("rejects sidecars that override third-party headers or lack a target", (t) => {
  const repo = repository(t);
  repo.write("vendor.ts", `${header("MIT")}export const vendor = true;\n`);
  repo.write("vendor.ts.license", sidecar());
  repo.write("absent.json.license", sidecar());
  assert.ok(repo.check().errors.some((error) => error.includes("header and sidecar disagree")));
  assert.ok(repo.check().errors.some((error) => error.includes("corresponding file is missing")));
});

test("keeps the complete Apache license unchanged", (t) => {
  const repo = repository(t);
  repo.write("LICENSE", `${APACHE}Changed\n`);
  assert.deepEqual(repo.check().errors, [
    "LICENSE must remain byte-for-byte identical to the Apache baseline.",
  ]);
});

test("renamed inherited files need explicit attribution at their new path", (t) => {
  const repo = repository(t);
  renameSync(path.join(repo.cwd, "inherited.ts"), path.join(repo.cwd, "renamed.ts"));
  assert.equal(repo.check().errors.length, 1);
  repo.write("renamed.ts", `${header("Apache-2.0")}export const inherited = true;\n`);
  assert.deepEqual(repo.check().errors, []);
});

test("does not follow newly added symlinks when reading headers", {
  skip: process.platform === "win32",
}, (t) => {
  const repo = repository(t);
  symlinkSync("inherited.ts", path.join(repo.cwd, "linked.ts"));
  assert.equal(repo.check().errors.length, 1);
  repo.write("linked.ts.license", sidecar("Apache-2.0"));
  assert.deepEqual(repo.check().errors, []);
  symlinkSync("missing.ts", path.join(repo.cwd, "broken.ts"));
  assert.ok(repo.check().errors.some((error) => error.startsWith("broken.ts:")));
});

test("reports unavailable baselines instead of silently skipping checks", (t) => {
  const repo = repository(t);
  assert.throws(
    () => checkLicenseHeaders({ cwd: repo.cwd, base: "not-a-commit" }),
    /baseline .* is unavailable/,
  );
});
