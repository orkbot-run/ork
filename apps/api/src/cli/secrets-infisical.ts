// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 migration behavior is preserved. Bounded interruption handling is an Ork addition.

import {
  ComposedSecretStore,
  contentKeyProviderFromEnv,
  EncryptedSecretStore,
  InfisicalSecretStore,
  migrateSecrets,
  PostgresRealtimeFanout,
  secretStoreOptionsFromEnv,
  unwrapEnvFromKeyManager,
} from "@orkbot/adapters";
import { resolveEncryptionKey } from "@orkbot/core";
import { loadRootEnv } from "@orkbot/core/node/load-root-env";
import { createDb, runAsSystem } from "@orkbot/db";
import { createSecretMigrationRepository } from "#modules/security/secret-migration";

import { migrationSignals } from "./migration-signals.js";

loadRootEnv();
await unwrapEnvFromKeyManager();

const args = process.argv.slice(2);
if (args.some((arg) => !["--dry-run", "--reverse"].includes(arg)))
  throw new Error("Usage: secrets:infisical [--dry-run] [--reverse]");
const options = secretStoreOptionsFromEnv({ ...process.env, SECRET_STORE: "infisical" });
if (!options || !process.env.DATABASE_URL)
  throw new Error("Secret storage and database configuration are required");
const { prisma, pool } = createDb(process.env.DATABASE_URL, {
  keyProvider: contentKeyProviderFromEnv(),
});
const encryptionKey = resolveEncryptionKey(process.env);
const realtime = new PostgresRealtimeFanout({
  connectionString: process.env.REALTIME_DATABASE_URL ?? process.env.DATABASE_URL,
  publisher: pool,
});
const encrypted = new ComposedSecretStore(
  new EncryptedSecretStore(encryptionKey),
  undefined,
  realtime,
);
const infisical = new ComposedSecretStore(
  new EncryptedSecretStore(encryptionKey),
  new InfisicalSecretStore(options),
  realtime,
);
const shutdown = migrationSignals();
const repository = createSecretMigrationRepository(prisma);
try {
  await encrypted.start();
  await infisical.start();
  // Migrates every tenant's secrets.
  const result = await runAsSystem("secret store migration", () =>
    migrateSecrets(
      repository,
      encrypted,
      infisical,
      {
        operationId: "secret-migration",
        traceId: "secret-migration",
        userId: "migration",
        spaceId: "migration",
        signal: shutdown.signal,
      },
      {
        direction: args.includes("--reverse") ? "reverse" : "forward",
        dryRun: args.includes("--dry-run"),
        report: (row, status) => process.stdout.write(`${row.label} ${row.id}: ${status}\n`),
      },
    ),
  );
  if (result.failed || shutdown.signal.aborted) process.exitCode = 1;
} catch {
  process.stderr.write("Secret migration failed\n");
  process.exitCode = 1;
} finally {
  await infisical.close().catch(() => {
    process.exitCode = 1;
  });
  await encrypted.close().catch(() => {
    process.exitCode = 1;
  });
  await realtime.close().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await pool.end().catch(() => undefined);
  shutdown.finish();
}
