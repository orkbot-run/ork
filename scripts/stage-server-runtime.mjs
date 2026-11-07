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
  "apps/web/vite.config.ts",
  "apps/web/lingui.config.ts",
  "apps/web/node_modules",
  "apps/web/dist",
  "apps/web/src/api-proxy.ts",
  "apps/web/src/asset-archive.ts",
  "apps/web/src/forwarded-for.ts",
  "apps/web/src/missing-asset.ts",
  "apps/web/src/novnc-html.ts",
  "apps/web/src/screen-proxy.ts",
  "apps/web/src/pwa/retire-build.ts",
  "apps/web/src/pwa/retire.ts",
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
