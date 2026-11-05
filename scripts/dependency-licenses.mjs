// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runPnpm } from "./pnpm.mjs";

const permissive = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSD-4-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "PSF-2.0",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);

const limitations = [
  "This inventory records installed pnpm dependency metadata, not legal approval or compatibility.",
  "Coverage depends on the current operating system, architecture, and installed optional packages.",
  "Native libraries, container images, fonts, and other assets need separate review.",
  "Review entries identify license terms to inspect, including alternatives in OR expressions.",
];

function reviewLicense(license) {
  if (license === "Unknown") return [{ license, reason: "missing-or-unsupported-metadata" }];
  const identifiers = license.match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g) ?? [];
  const reviews = [];
  for (const identifier of new Set(identifiers)) {
    if (["AND", "OR", "WITH"].includes(identifier) || permissive.has(identifier)) continue;
    let reason = "unclassified-license-or-exception";
    if (/^AGPL-/.test(identifier)) reason = "network-copyleft";
    else if (/^GPL-/.test(identifier)) reason = "copyleft";
    else if (/^LGPL-/.test(identifier)) reason = "library-copyleft";
    else if (/^(MPL-|EPL-|CDDL-)/.test(identifier)) reason = "file-or-module-copyleft";
    else if (/^(FSL-|BUSL-|PolyForm-|Elastic-)/.test(identifier)) reason = "source-available-terms";
    else if (/^SSPL-/.test(identifier)) reason = "service-source-disclosure-terms";
    else if (/^CC-BY/.test(identifier)) reason = "attribution-or-sharing-terms";
    reviews.push({ license: identifier, reason });
  }
  return reviews;
}

function normalizeLicense(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9().+ -]{1,200}$/.test(value)) return "Unknown";
  if (value === "Apache License 2.0") return "Apache-2.0";
  return value
    .replace(/(^|[ (])and(?=[ )]|$)/gi, "$1AND")
    .replace(/(^|[ (])or(?=[ )]|$)/gi, "$1OR");
}

export function createLicenseReport(metadata, scope) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Invalid dependency license metadata");
  }
  if (!["production", "all"].includes(scope)) throw new Error("Invalid dependency scope");
  const packages = [];
  for (const [rawLicense, entries] of Object.entries(metadata)) {
    if (!Array.isArray(entries)) throw new Error("Invalid dependency license entries");
    const license = normalizeLicense(rawLicense);
    for (const entry of entries) {
      if (
        !entry ||
        typeof entry.name !== "string" ||
        !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(entry.name) ||
        !Array.isArray(entry.versions) ||
        !entry.versions.length ||
        !entry.versions.every(
          (version) =>
            typeof version === "string" &&
            /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version),
        )
      ) {
        throw new Error("Invalid dependency identity metadata");
      }
      packages.push({
        name: entry.name,
        versions: [...new Set(entry.versions)].sort(),
        license,
        review: reviewLicense(license),
      });
    }
  }
  if (!packages.length) throw new Error("Dependency license inventory is empty");
  packages.sort((a, b) =>
    `${a.name}\0${a.versions.join(",")}\0${a.license}`.localeCompare(
      `${b.name}\0${b.versions.join(",")}\0${b.license}`,
      "en",
    ),
  );
  return { schemaVersion: 1, scope, limitations, packages };
}

export function collectLicenseReports({ outputDirectory, scan = scanInstalledDependencies }) {
  const production = createLicenseReport(scan(true), "production");
  const all = createLicenseReport(scan(false), "all");
  const reviewRequired = {
    schemaVersion: 1,
    limitations,
    production: production.packages.filter((entry) => entry.review.length),
    all: all.packages.filter((entry) => entry.review.length),
  };
  mkdirSync(outputDirectory, { recursive: true });
  for (const [name, report] of Object.entries({
    production,
    all,
    "review-required": reviewRequired,
  })) {
    writeFileSync(
      path.join(outputDirectory, `${name}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return { production, all, reviewRequired };
}

function scanInstalledDependencies(production) {
  const args = ["licenses", "list", "--json"];
  if (production) args.push("--prod");
  const output = runPnpm(args, {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { production, all, reviewRequired } = collectLicenseReports({
      outputDirectory: process.argv[2] ?? "test-report/dependency-licenses",
    });
    console.log(
      `Dependency inventory: ${production.packages.length} production and ${all.packages.length} total entries.`,
    );
    console.log(
      `Review required: ${reviewRequired.production.length} production and ${reviewRequired.all.length} total entries.`,
    );
    console.log(
      "Reports record metadata and review items. They do not certify license compliance.",
    );
  } catch {
    console.error(
      "Could not generate dependency license reports. Check installation and pnpm metadata.",
    );
    process.exitCode = 1;
  }
}
