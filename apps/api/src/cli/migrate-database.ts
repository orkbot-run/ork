// `pnpm db:migrate`: schema migrations, the job queue schema, then the runtime
// login. Everything here runs as the migration (owner) role; the API and worker
// then connect with DATABASE_URL and only get the runtime grants.
import { execFileSync } from "node:child_process";
import { migrateJobQueue, unwrapEnvFromKeyManager } from "@orkbot/adapters";
import { loadRootEnv } from "@orkbot/core/node/load-root-env";
import {
  databaseUrls,
  deployMigrations,
  provisionRuntimeRole,
  RUNTIME_ROLE,
  SINGLE_DATABASE_URL_WARNING,
} from "@orkbot/db";

loadRootEnv();
await unwrapEnvFromKeyManager();
const urls = databaseUrls(process.env);
await deployMigrations({
  migrationUrl: urls.migrationUrl,
  previousMigrations: process.env.ORKBOT_DEPLOYED_MIGRATIONS?.split(","),
  dbPackageDir: execFileSync("pnpm", ["--filter", "@orkbot/db", "exec", "pwd"], {
    encoding: "utf8",
  }).trim(),
});
await migrateJobQueue(urls.migrationUrl);

if (!urls.separate) {
  process.stderr.write(`WARNING: ${SINGLE_DATABASE_URL_WARNING}\n`);
} else {
  const { warning } = await provisionRuntimeRole(urls.migrationUrl, urls.url);
  if (warning) process.stderr.write(`WARNING: ${warning}\n`);
  else process.stdout.write(`Runtime login is ready (member of ${RUNTIME_ROLE}).\n`);
}
