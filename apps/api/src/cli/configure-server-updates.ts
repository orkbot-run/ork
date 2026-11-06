// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configureServerUpdates,
  loadServerUpdatesConfig,
  parseServerUpdatesConfig,
} from "@orkbot/adapters/server-updates-config";
import { createDb, runAsSystem } from "@orkbot/db";

/** Derive delegation only after an explicit local operator command, never from an app session. */
export async function configureFromInput(
  input: unknown,
  options: { delegateCurrentOwner: boolean; root: string; uid?: number },
  owner: () => Promise<string | null>,
) {
  if (!options.delegateCurrentOwner) throw new Error("Explicit delegation is required.");
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid input.");
  const source = input as Record<string, unknown>;
  if (
    Object.keys(source).length !== 2 ||
    !Object.hasOwn(source, "channel") ||
    !Object.hasOwn(source, "adapter")
  )
    throw new Error("Invalid input.");
  // Validate the secret before opening a database connection.
  const checked = parseServerUpdatesConfig({
    ...source,
    version: 1,
    installationId: randomUUID(),
    controllerAccountKey: "0".repeat(64),
  });
  const controllerAccountKey = await owner();
  if (!controllerAccountKey || !/^[a-f0-9]{64}$/.test(controllerAccountKey))
    throw new Error("Initialize the server first.");
  const previous = loadServerUpdatesConfig(`${options.root}/updates.json`, options.uid);
  configureServerUpdates({
    root: options.root,
    uid: options.uid,
    config: {
      ...checked,
      controllerAccountKey,
      installationId: previous?.installationId ?? checked.installationId,
    },
  });
}

async function currentOwner(): Promise<string | null> {
  if (!process.env.DATABASE_URL) throw new Error("Run with the API runtime configuration.");
  const { prisma, pool } = createDb(process.env.DATABASE_URL);
  try {
    return await runAsSystem(
      "delegate deployment updates to the initialized owner",
      async () =>
        (
          await prisma.deploymentSettings.findUnique({
            where: { id: "default" },
            select: { nativeAccountsOwnerKey: true },
          })
        )?.nativeAccountsOwnerKey ?? null,
    );
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 3 ||
    args[0] !== "--delegate-current-owner" ||
    args[1] !== "--root" ||
    !args[2]
  )
    throw new Error("Invalid arguments.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk);
    if (size > 8192) throw new Error("Input too large.");
    chunks.push(Buffer.from(chunk));
  }
  await configureFromInput(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
    { delegateCurrentOwner: true, root: resolve(args[2]) },
    currentOwner,
  );
  process.stdout.write("Server update delegation saved. Redeploy the API to load it.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Database errors and network failures may contain secrets; never print their details.
    process.stderr.write(
      "Could not configure server updates. Check the private input, initialized owner, and writable configuration mount.\n",
    );
    process.exitCode = 1;
  });
}
