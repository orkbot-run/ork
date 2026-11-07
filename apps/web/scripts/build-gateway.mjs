// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { serverBuildOptions } from "../../../scripts/build-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function buildGateway(outfile = path.join(root, "server/index.js")) {
  await build(serverBuildOptions(path.join(root, "src/gateway/index.ts"), outfile));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildGateway();
