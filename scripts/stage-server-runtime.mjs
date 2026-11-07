// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtimePaths = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "node_modules",
  "LICENSE",
  "LICENSE-POLYFORM",
  "LICENSE.md",
  "NOTICE",
  "apps/api",
  "apps/worker",
  "apps/web/package.json",
  "apps/web/node_modules",
  "apps/web/dist",
  "apps/web/server",
  "packages/adapter-kit",
  "packages/adapters",
  "packages/auth",
  "packages/avatar",
  "packages/chat-ui",
  "packages/contracts",
  "packages/core",
  "packages/db",
  "packages/logging",
  "packages/memory",
  "packages/page-kit",
  "packages/ui-tokens",
  "packages/ui-web",
  "infra/compose",
  "infra/railway",
  "infra/sandboxes/computer",
  "infra/sandboxes/supervisor",
  "scripts",
];

/** Preserve pnpm's relative links and the paths baked into server bundles. */
export function stageServerRuntime(source, destination) {
  for (const relative of runtimePaths) {
    const original = path.join(source, relative);
    const target = path.join(destination, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(original, target, { recursive: true, verbatimSymlinks: true });
    if (statSync(original).isFile() && existsSync(`${original}.license`)) {
      cpSync(`${original}.license`, `${target}.license`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  stageServerRuntime(process.cwd(), path.resolve(process.argv[2]));
}
