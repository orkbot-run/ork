// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { InstallationClient } from "@orkbot/auth/installation-client";

export function serverEnrollmentInstructions(
  code: string,
  expiresAt: number,
  fingerprint: string,
): string {
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{10}$/.test(code) || !/^[a-f0-9]{64}$/.test(fingerprint))
    throw new Error("Invalid server authorization code.");
  const remaining = expiresAt * 1000 - Date.now();
  if (!Number.isSafeInteger(expiresAt) || remaining <= 0)
    throw new Error("Server authorization has expired.");
  const minutes = Math.min(15, Math.ceil(remaining / 60_000));
  const duration = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  return `\nConnect your server:\nhttps://app.ork.run/account/connect-server#code=${code}\n\nSetup code: ${code}\nFingerprint: ${fingerprint}\n\nIn Accounts, select your organization, enter the code on Servers, and verify the fingerprint before approving.\nThe code expires in ${duration}.\n`;
}

/** The current Accounts dashboard accepts installation enrollments, not legacy claims. */
export async function startServerEnrollment(installation: InstallationClient): Promise<string> {
  await installation.resetExpiredEnrollment();
  if (await installation.resumePendingEnrollment()) return "Server enrollment confirmed.\n";
  const ticket = await installation.beginEnrollment("Ork server");
  return serverEnrollmentInstructions(ticket.code, ticket.expiresAt, ticket.keyFingerprint);
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
