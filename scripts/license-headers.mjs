// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LICENSE_BASELINE = "7efb3c5e202ddb4a4da3cd07904cba7da4613d18";
const COMPLETE_NOTICES = new Set(["LICENSE", "LICENSE-POLYFORM", "NOTICE"]);
const IDENTIFIER = /^SPDX-License-Identifier:\s*([A-Za-z0-9().+\-: ]+)$/;
const COPYRIGHT = /^SPDX-FileCopyrightText:\s*\S/;

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

function names(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

function present(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function metadata(text, sidecar = false) {
  const lines = [];
  for (const original of text.split(/\r?\n/).slice(0, 40)) {
    const line = original.trim();
    if (sidecar) {
      lines.push(line);
      continue;
    }
    if (!line || line.startsWith("#!") || line === "---" || /^<\?xml\b.*\?>$/.test(line)) {
      continue;
    }
    if (/^(\/\*|\*\/|<!--|-->)$/.test(line)) continue;
    const comment = line.match(/^(?:\/\/|#|--|\/\*|\*|<!--)\s*(.*?)\s*(?:\*\/|-->)?$/);
    if (!comment) break;
    lines.push(comment[1]);
  }
  return {
    identifiers: lines.map((line) => line.match(IDENTIFIER)?.[1]?.trim()).filter(Boolean),
    copyright: lines.some((line) => COPYRIGHT.test(line)),
  };
}

/** Check labels on new paths, without inferring authorship or permission to relicense. */
export function checkLicenseHeaders({ cwd = process.cwd(), base = LICENSE_BASELINE } = {}) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  if (!base || base.startsWith("-")) throw new Error("A baseline commit is required.");
  let commit;
  try {
    commit = git(root, ["rev-parse", "--verify", `${base}^{commit}`])
      .toString("utf8")
      .trim();
  } catch {
    throw new Error(`License baseline ${base} is unavailable. Fetch the repository history.`);
  }
  const inherited = new Set(names(git(root, ["ls-tree", "-r", "--name-only", "-z", commit])));
  const files = [
    ...new Set(names(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))),
  ].filter((file) => present(path.join(root, file)));
  const added = files.filter((file) => !inherited.has(file));
  const errors = [];
  const license = path.join(root, "LICENSE");
  if (
    !existsSync(license) ||
    !lstatSync(license).isFile() ||
    !readFileSync(license).equals(git(root, ["show", `${commit}:LICENSE`]))
  ) {
    errors.push("LICENSE must remain byte-for-byte identical to the Apache baseline.");
  }

  for (const file of added) {
    if (COMPLETE_NOTICES.has(file)) continue;
    const absolute = path.join(root, file);
    const stat = lstatSync(absolute);
    if (file.endsWith(".license")) {
      if (!stat.isFile()) {
        errors.push(`${file}: a license sidecar must be a regular file.`);
        continue;
      }
      const sidecar = metadata(readFileSync(absolute, "utf8"), true);
      if (sidecar.identifiers.length !== 1 || !sidecar.copyright) {
        errors.push(`${file}: include one SPDX-License-Identifier and SPDX-FileCopyrightText.`);
      }
      if (!files.includes(file.slice(0, -".license".length))) {
        errors.push(`${file}: the corresponding file is missing.`);
      }
      continue;
    }
    const content = stat.isFile() ? readFileSync(absolute) : null;
    const needsSidecar =
      !content || content.includes(0) || /\.(?:json|jsonl|map|ipynb)$/i.test(file);
    const header =
      content && !needsSidecar ? metadata(content.toString("utf8")) : { identifiers: [] };
    const sidecarPath = `${file}.license`;
    const hasSidecar = files.includes(sidecarPath);
    let sidecar;
    if (hasSidecar && lstatSync(path.join(root, sidecarPath)).isFile()) {
      sidecar = metadata(readFileSync(path.join(root, sidecarPath), "utf8"), true);
    }
    if (header.identifiers.length > 1) {
      errors.push(`${file}: use one SPDX expression to describe the applicable licenses.`);
    } else if (header.identifiers.length === 1) {
      if (sidecar && sidecar.identifiers[0] !== header.identifiers[0]) {
        errors.push(`${file}: the header and sidecar disagree. Preserve third-party notices.`);
      }
    } else if (sidecar?.identifiers.length !== 1 || !sidecar.copyright) {
      errors.push(`${file}: add an SPDX header or a .license sidecar with copyright attribution.`);
    }
  }
  return { added: added.length, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--base")) {
      throw new Error("Usage: node scripts/license-headers.mjs [--base <commit>]");
    }
    const result = checkLicenseHeaders({ base: args[1] ?? LICENSE_BASELINE });
    if (result.errors.length) {
      process.stderr.write(`${result.errors.join("\n")}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`License headers checked for ${result.added} new files.\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
