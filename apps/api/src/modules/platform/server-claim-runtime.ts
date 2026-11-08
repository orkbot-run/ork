// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function serverClaimInstructions(code: string, workspace = false): string {
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{10}$/.test(code))
    throw new Error("Invalid server authorization code.");
  if (workspace)
    return `Enter this code in your workspace dashboard under Server:\n${code}\n\nThe code expires in five minutes. Sign in as this server's current owner.\n`;
  return `Server setup code: ${code}\n\nTo connect a workspace, open your workspace dashboard, choose an organization, and enter the code under Server.\n\nTo connect a personal account instead, open:\nhttps://accounts.ork.run/account/connect-server#code=${code}\n\nApprove the server only in the flow you intend to use. The code expires in five minutes.\n`;
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
