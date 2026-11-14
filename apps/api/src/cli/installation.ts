// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  contentKeyProviderFromEnv,
  PostgresRealtimeFanout,
  unwrapEnvFromKeyManager,
} from "@orkbot/adapters";
import { FilePersonalRevocations, InstallationClient, WorkspaceAuthority } from "@orkbot/auth";
import type { InstallationConfiguration } from "@orkbot/auth/installation-client";
import { resolveEncryptionKey } from "@orkbot/core";
import { loadRootEnv } from "@orkbot/core/node/load-root-env";
import { createDb } from "@orkbot/db";
import { setAIAdministrator } from "#modules/models/ai-administrators";
import { loadServerClaimRuntime } from "#modules/platform/server-claim-runtime";

await loadServerClaimRuntime(process.env);
loadRootEnv();
await unwrapEnvFromKeyManager();
const required = (name: string) => {
  const at = process.argv.indexOf(name);
  const value = at < 0 ? undefined : process.argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`Supply ${name}`);
  return value;
};
const optional = (name: string) => (process.argv.includes(name) ? required(name) : undefined);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const issuer = process.env.ACCOUNTS_ISSUER ?? "https://api.ork.run";
if (process.env.NODE_ENV === "production" && issuer !== "https://api.ork.run")
  throw new Error("Unsupported production Accounts issuer");
const database = createDb(process.env.DATABASE_URL, { keyProvider: contentKeyProviderFromEnv() });
const installation = new InstallationClient(database.prisma, {
  issuer,
  encryptionKey: resolveEncryptionKey(process.env),
});
const realtime = new PostgresRealtimeFanout({
  connectionString: process.env.REALTIME_DATABASE_URL ?? process.env.DATABASE_URL,
  publisher: database.pool,
});
const authority = new WorkspaceAuthority(
  database.prisma,
  installation,
  issuer,
  realtime,
  new FilePersonalRevocations(
    join(process.env.DATA_DIR ?? "./data", "identity", "personal-revocations"),
  ),
);
try {
  switch (process.argv[2]) {
    case "enroll": {
      const name = required("--name");
      const organization = optional("--organization");
      await installation.resetExpiredEnrollment(organization);
      const configuration = organization
        ? await installation.configuration()
        : await installation.resumePendingEnrollment();
      if (configuration) {
        if (organization && configuration.organizationId !== organization)
          throw new Error("Installation organization selection changed");
        process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
      } else {
        process.stdout.write(
          `${JSON.stringify(await installation.beginEnrollment(name, organization))}\n`,
        );
      }
      break;
    }
    case "reconnect": {
      let refused: InstallationConfiguration | undefined;
      try {
        const ticket = await installation.reconnectEnrollment(
          required("--name"),
          required("--organization"),
          async (serverId, transaction, configuration) => {
            refused = configuration;
            await authority.refuseInstallation(serverId, true, transaction);
          },
        );
        process.stdout.write(`${JSON.stringify(ticket)}\n`);
      } catch (error) {
        // The transaction has released its connection; this bound event adds no local effects.
        if (refused) await authority.broadcastRefusal(refused);
        throw error;
      }
      break;
    }
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
        "Use enroll, reconnect, confirm, status, publish-routes, map-workspace, grant-ai-admin or revoke-ai-admin",
      );
  }
} finally {
  authority.dispose();
  await realtime.close();
  await database.prisma.$disconnect();
  await database.pool.end();
}
