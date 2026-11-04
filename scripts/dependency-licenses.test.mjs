// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectLicenseReports, createLicenseReport } from "./dependency-licenses.mjs";

const dependency = (name, extra = {}) => ({ name, versions: ["1.2.3"], ...extra });

test("published reports discard paths, authors, URLs, and unexpected pnpm fields", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dependency-licenses-"));
  try {
    const scans = [];
    collectLicenseReports({
      outputDirectory: directory,
      scan(production) {
        scans.push(production);
        return {
          MIT: [
            dependency("example-package", {
              paths: ["/private/example/node_modules/example-package"],
              author: "PRIVATE_AUTHOR",
              homepage: "https://private.invalid/secret",
              license: "PRIVATE_LICENSE_FIELD",
              unexpected: { secret: "PRIVATE_VALUE" },
            }),
          ],
          ...(production ? {} : { Unknown: [dependency("development-package")] }),
        };
      },
    });
    assert.deepEqual(scans, [true, false]);
    assert.deepEqual(readdirSync(directory).sort(), [
      "all.json",
      "production.json",
      "review-required.json",
    ]);
    for (const name of readdirSync(directory)) {
      const text = readFileSync(path.join(directory, name), "utf8");
      assert.doesNotMatch(text, /PRIVATE_|\/private\/|private\.invalid|paths|author|homepage/);
    }
    const reviews = JSON.parse(readFileSync(path.join(directory, "review-required.json"), "utf8"));
    assert.equal(reviews.production.length, 0);
    assert.equal(reviews.all[0].name, "development-package");
    assert.equal(reviews.all[0].review[0].reason, "missing-or-unsupported-metadata");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("copyleft and source-available alternatives stay visible without declaring incompatibility", () => {
  const report = createLicenseReport(
    {
      "(MPL-2.0 OR Apache-2.0)": [dependency("alternative-package")],
      "LGPL-3.0-or-later": [dependency("native-library")],
      "FSL-1.1-MIT": [dependency("source-available-package")],
      "GPL-3.0-only": [dependency("copyleft-package")],
      "EPL-2.0": [dependency("module-package")],
    },
    "production",
  );
  assert.equal(report.packages.length, 5);
  const alternative = report.packages.find((entry) => entry.name === "alternative-package");
  assert.equal(alternative.license, "(MPL-2.0 OR Apache-2.0)");
  assert.equal(
    report.packages.find((entry) => entry.name === "native-library").license,
    "LGPL-3.0-or-later",
  );
  assert.deepEqual(alternative.review, [{ license: "MPL-2.0", reason: "file-or-module-copyleft" }]);
  assert.deepEqual(
    report.packages.map((entry) => entry.review[0].reason).sort(),
    [
      "copyleft",
      "file-or-module-copyleft",
      "file-or-module-copyleft",
      "library-copyleft",
      "source-available-terms",
    ].sort(),
  );
});

test("missing and unfamiliar metadata remain review items", () => {
  const report = createLicenseReport(
    {
      Unknown: [dependency("missing-package")],
      Beerware: [dependency("unclassified-package")],
      "SEE LICENSE IN /private/license.txt": [dependency("unsupported-package")],
    },
    "all",
  );
  assert.equal(report.packages.length, 3);
  assert.ok(report.packages.every((entry) => entry.review.length));
  assert.doesNotMatch(JSON.stringify(report), /\/private\//);
});

test("empty or malformed scans fail instead of producing an apparently complete inventory", () => {
  for (const input of [
    null,
    [],
    {},
    { MIT: {} },
    { MIT: [dependency("../private")] },
    { MIT: [dependency("example", { versions: ["file:/private/package"] })] },
  ]) {
    assert.throws(() => createLicenseReport(input, "production"));
  }
});

test("metadata order and duplicate versions do not change the published inventory", () => {
  const first = createLicenseReport(
    {
      "MIT and ISC": [dependency("z-package")],
      "Apache License 2.0": [dependency("a-package", { versions: ["2.0.0", "1.0.0", "2.0.0"] })],
    },
    "all",
  );
  const second = createLicenseReport(
    {
      "Apache-2.0": [dependency("a-package", { versions: ["1.0.0", "2.0.0"] })],
      "MIT AND ISC": [dependency("z-package")],
    },
    "all",
  );
  assert.deepEqual(first, second);
  assert.ok(first.packages.every((entry) => entry.review.length === 0));
});
