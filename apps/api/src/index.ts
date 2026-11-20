// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 startup is preserved. Accounts configuration and HTTP timeouts are Ork additions.

import { unwrapEnvFromKeyManager } from "@orkbot/adapters";
import { loadServerUpdatesConfig } from "@orkbot/adapters/server-updates-config";
import { loadRootEnv } from "@orkbot/core/node/load-root-env";
import { stopOnShutdownSignals } from "@orkbot/core/node/shutdown-signals";

loadRootEnv();
await unwrapEnvFromKeyManager();

import { SERVICE_NAMES } from "@orkbot/logging";
import { createRootLogger } from "@orkbot/logging/axiom";
import { loadProductEnv } from "#modules/platform/env";
import { API_SHUTDOWN_DEADLINE_MS, createApiHttpServer } from "#modules/platform/http-drain";
import { createApp } from "./app.js";

const logger = await createRootLogger(SERVICE_NAMES.api);

try {
  const env = loadProductEnv();
  const updates = await loadServerUpdatesConfig();
  const serverUpdateSetup = updates
    ? {
        installationId: updates.installationId,
        delegatedAccountKey: updates.controllerAccountKey,
        adapter:
          updates.adapter.kind === "standalone"
            ? (
                await import("@orkbot/adapters/standalone-server-updates")
              ).createStandaloneServerUpdateAdapter({
                channel: updates.channel,
                currentRevision: env.gitSha ?? null,
                token: updates.adapter.token,
              })
            : (
                await import("@orkbot/adapters/easypanel-server-updates")
              ).createEasypanelServerUpdateAdapter({
                channel: updates.channel,
                currentRevision: env.gitSha ?? null,
                deploymentTrigger: updates.adapter.deploymentTrigger,
              }),
      }
    : undefined;
  const { app, stop, handleUpgrade } = await createApp({ ...env, logger, serverUpdateSetup });
  const { server, drain } = createApiHttpServer({
    fetch: app.fetch,
    hostname: env.apiHost,
    handleUpgrade,
  });
  server.listen(env.port, env.apiHost, () => {
    logger.info("api listening", { "http.host": env.apiHost, "http.port": env.port });
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => {
      logger.error("api shutdown deadline exceeded");
      process.exit(1);
    }, API_SHUTDOWN_DEADLINE_MS).unref();
    try {
      await drain();
      await stop();
    } catch (error) {
      logger.error("api shutdown failed", error);
      process.exitCode = 1;
    } finally {
      await logger.flush({ timeoutMs: 2_000 });
    }
  };
  stopOnShutdownSignals(shutdown);
} catch (error) {
  logger.error("api startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  process.exit(1);
}
