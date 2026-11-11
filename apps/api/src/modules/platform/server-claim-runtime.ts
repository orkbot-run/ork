// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function serverClaimInstructions(
  code: string,
  expiresAt: number,
  workspace = false,
): string {
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{10}$/.test(code))
    throw new Error("Invalid server authorization code.");
  const remaining = expiresAt * 1000 - Date.now();
  if (!Number.isSafeInteger(expiresAt) || remaining <= 0)
    throw new Error("Server authorization has expired.");
  const minutes = Math.min(10, Math.ceil(remaining / 60_000));
  const duration = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  if (!workspace)
    return `Enter this code at https://accounts.ork.run/account/connect-server:\n${code}\n\nThe code expires in ${duration}.\n`;
  return `Enter this code in your workspace dashboard under Server:\n${code}\n\nThe code expires in ${duration}. If the server already has an owner, sign in as that owner.\n`;
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
