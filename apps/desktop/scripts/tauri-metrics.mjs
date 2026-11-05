// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const directory = process.argv[2];
if (!directory || process.argv.length !== 3) {
  throw new Error("Usage: node tauri-metrics.mjs <bundle-directory>");
}

const root = path.resolve(directory);
const installers = [];

async function collect(current) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    // An unpacked .app is not an installer, and its nested resources must not be counted twice.
    if (entry.isDirectory() && !entry.name.endsWith(".app")) {
      await collect(file);
    } else if (entry.isFile() && /\.(?:AppImage|dmg|exe|msi|deb|rpm|tar\.gz)$/.test(entry.name)) {
      installers.push({
        name: path.relative(root, file).split(path.sep).join("/"),
        bytes: (await stat(file)).size,
      });
    }
  }
}

await collect(root);
if (installers.length === 0) throw new Error("No installers were produced.");
installers.sort((left, right) => left.name.localeCompare(right.name, "en"));
process.stdout.write(
  `${JSON.stringify({ installers, totalBytes: installers.reduce((sum, file) => sum + file.bytes, 0) }, null, 2)}\n`,
);
