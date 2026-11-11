// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@orkbot/adapters";
import { clearWorkspaceBinding, issueServerClaim, synchronizeWorkspaceBinding } from "@orkbot/auth";
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
  const clearIndex = process.argv.indexOf("--clear-workspace");
  if (process.argv.includes("--disconnect-workspace")) {
    if (clearIndex !== -1 || process.argv.includes("--workspace"))
      throw new Error("Use --disconnect-workspace on its own.");
    const result = await runAsSystem("disconnect workspace", () =>
      synchronizeWorkspaceBinding(prisma, {
        issuer: "https://api.orkbot.run",
        origin,
        bootstrapSecret: secret,
        disconnect: true,
      }),
    );
    if (result === "legacy")
      throw new Error(
        "This connection predates coordinated disconnection. Remove it from the dashboard, then use --clear-workspace with the workspace ID.",
      );
    process.stdout.write(
      result === "unconnected"
        ? "This server is not connected to a workspace.\n"
        : "Workspace disconnected. The server owner and existing data were preserved.\n",
    );
  } else if (clearIndex !== -1) {
    const organizationId = process.argv[clearIndex + 1];
    if (!organizationId) throw new Error("Supply the workspace ID after --clear-workspace.");
    await runAsSystem("local workspace reset", () => clearWorkspaceBinding(prisma, organizationId));
    process.stdout.write(
      "Local workspace binding removed. Existing users and data were preserved.\n",
    );
  } else {
    const claim = await runAsSystem("local server authorization", () =>
      issueServerClaim(prisma, {
        origin,
        issuer: "https://api.orkbot.run",
        bootstrapSecret: secret,
        mode: "workspace",
      }),
    );
    process.stdout.write(serverClaimInstructions(claim.code, claim.expiresAt, true));
  }
} finally {
  await prisma.$disconnect();
  await pool.end();
}
