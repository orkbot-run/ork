// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { readFile } from "node:fs/promises";
import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@orkbot/adapters";
import { InstallationClient, WorkspaceAuthority } from "@orkbot/auth";
import { resolveEncryptionKey } from "@orkbot/core";
import { loadRootEnv } from "@orkbot/core/node/load-root-env";
import { createDb } from "@orkbot/db";
import { setAIAdministrator } from "#modules/models/ai-administrators";

loadRootEnv();
await unwrapEnvFromKeyManager();
const required = (name: string) => {
  const at = process.argv.indexOf(name);
  const value = at < 0 ? undefined : process.argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`Supply ${name}`);
  return value;
};
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const issuer = process.env.ACCOUNTS_ISSUER ?? "https://api.ork.run";
if (process.env.NODE_ENV === "production" && issuer !== "https://api.ork.run")
  throw new Error("Unsupported production Accounts issuer");
const database = createDb(process.env.DATABASE_URL, { keyProvider: contentKeyProviderFromEnv() });
const installation = new InstallationClient(database.prisma, {
  issuer,
  encryptionKey: resolveEncryptionKey(process.env),
});
const authority = new WorkspaceAuthority(database.prisma, installation, issuer);
try {
  switch (process.argv[2]) {
    case "enroll":
      process.stdout.write(
        `${JSON.stringify(await installation.beginEnrollment(required("--name"), required("--organization")))}\n`,
      );
      break;
    case "confirm":
      process.stdout.write(
        `${JSON.stringify({ ready: Boolean(await installation.pollEnrollment()) })}\n`,
      );
      break;
    case "publish-routes": {
      const input = await readFile(required("--file"), "utf8");
      if (Buffer.byteLength(input) > 64 * 1024) throw new Error("Routes file is too large");
      await installation.publishRoutes(JSON.parse(input));
      process.stdout.write("Installation routes published.\n");
      break;
    }
    case "status":
      process.stdout.write(`${JSON.stringify(await installation.configuration())}\n`);
      break;
    case "map-workspace":
      await authority.synchronize();
      await authority.mapWorkspace(
        required("--workspace"),
        required("--local-organization"),
        required("--local-workspace"),
      );
      await authority.synchronize();
      process.stdout.write("Workspace mapping acknowledged.\n");
      break;
    case "grant-ai-admin":
    case "revoke-ai-admin":
      await setAIAdministrator(database.prisma, {
        accountKey: required("--account-key"),
        fingerprint: required("--fingerprint"),
        enabled: process.argv[2] === "grant-ai-admin",
      });
      process.stdout.write("AI administration delegation saved.\n");
      break;
    default:
      throw new Error(
        "Use enroll, confirm, status, publish-routes, map-workspace, grant-ai-admin or revoke-ai-admin",
      );
  }
} finally {
  authority.dispose();
  await database.prisma.$disconnect();
  await database.pool.end();
}
