// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@orkbot/adapters";
import { issueServerClaim } from "@orkbot/auth";
import { createDb, runAsSystem } from "@orkbot/db";
import {
  loadServerClaimRuntime,
  serverClaimInstructions,
} from "#modules/platform/server-claim-runtime";

await loadServerClaimRuntime(process.env);
await unwrapEnvFromKeyManager();

const secret = process.env.ORKBOT_BOOTSTRAP_SECRET;
const origin = process.env.WEB_ORIGIN;
const databaseUrl = process.env.DATABASE_URL;
if (
  process.env.AUTH_ACCOUNTS_ENABLED !== "true" ||
  process.env.ORKBOT_DESKTOP_ACCOUNT_KEY ||
  !secret ||
  !origin ||
  !databaseUrl
)
  throw new Error("Server authorization is unavailable in this environment.");
const url = new URL(origin);
if (url.protocol !== "https:" || url.origin !== origin || url.port || url.username || url.password)
  throw new Error("Server authorization requires the server's public HTTPS origin.");
const { prisma, pool } = createDb(databaseUrl, { keyProvider: contentKeyProviderFromEnv() });
try {
  const claim = await runAsSystem("local server authorization", () =>
    issueServerClaim(prisma, { origin, issuer: "https://api.orkbot.run", bootstrapSecret: secret }),
  );
  process.stdout.write(serverClaimInstructions(claim.code));
} finally {
  await prisma.$disconnect();
  await pool.end();
}
