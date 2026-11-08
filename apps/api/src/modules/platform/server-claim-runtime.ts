// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function serverClaimInstructions(code: string): string {
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{10}$/.test(code))
    throw new Error("Invalid server authorization code.");
  return `Open this link to authorize the server:\nhttps://accounts.ork.run/account/connect-server#code=${code}\n\nOr enter this code at https://accounts.ork.run/account/connect-server:\n${code}\n\nThe link and code expire in five minutes.\n`;
}

/** The Compose self-host API stores its role environment in a private mounted file. */
export async function loadServerClaimRuntime(
  environment: NodeJS.ProcessEnv,
  config = "/run/orkbot/environment.json",
  loader = pathToFileURL("/app/infra/compose/selfhost-runtime.mjs").href,
): Promise<void> {
  if (environment.ORKBOT_BOOTSTRAP_SECRET || !existsSync(config)) return;
  const runtime = (await import(loader)) as {
    readRuntimeConfig(path: string): Record<string, string>;
  };
  Object.assign(environment, runtime.readRuntimeConfig(config));
}
