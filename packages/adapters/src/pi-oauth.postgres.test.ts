// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { randomUUID } from "node:crypto";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { asSystem, createDb } from "@orkbot/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import type * as ModelOAuth from "./pi-oauth.js";
import { withSecretPersistence } from "./secret-persistence.js";
import { EncryptedSecretStore } from "./secrets.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("model OAuth refresh (PostgreSQL contract)", () => {
  const databases: Array<ReturnType<typeof createDb>> = [];
  const users: string[] = [];
  const secrets = new EncryptedSecretStore("test-only-model-encryption-key");
  const provider = "openai-codex";

  function openDb(poolMax = 1) {
    const db = createDb(databaseUrl!, { poolMax });
    databases.push(db);
    return db;
  }

  afterAll(async () => {
    const [first] = databases;
    if (first) {
      const prisma = asSystem(first.prisma);
      await prisma.organization.deleteMany({ where: { id: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
    for (const db of databases) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function separateInstances(): Promise<Array<typeof ModelOAuth>> {
    const instances: Array<typeof ModelOAuth> = [];
    for (let index = 0; index < 3; index++) {
      // Separate module state prevents a process-local lock from hiding the race.
      vi.resetModules();
      instances.push(await import("./pi-oauth.js"));
    }
    return instances;
  }

  it("coordinates background, run-start and runtime refreshes across independent pools", async () => {
    const instances = await separateInstances();
    const [background, runStart, runtime] = instances;
    const monitor = openDb();
    const prisma = asSystem(monitor.prisma);
    const id = randomUUID();
    users.push(id);
    const scope = { userId: id, spaceId: id };
    await prisma.user.create({
      data: { id, name: "OAuth test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "OAuth test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "OAuth test", isDefault: true },
    });
    const expired: OAuthCredential = {
      type: "oauth",
      access: "access-0",
      refresh: "refresh-0",
      expires: 1,
      accountId: "test-account",
    };
    const plaintext = background!.serializeModelSecret({ kind: "oauth", credential: expired });
    const stored = await secrets.put(plaintext, {
      ...scope,
      operationId: "test",
      traceId: "test",
      signal: new AbortController().signal,
    });
    await prisma.secret.create({
      data: {
        id: stored.id,
        userId: id,
        spaceId: null,
        kind: "model",
        ciphertext: stored.ciphertext,
      },
    });
    const clients = instances.map(() => {
      const db = openDb();
      return asSystem(withSecretPersistence(db.prisma, secrets));
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const rotated = {
      ...expired,
      access: "access-1",
      refresh: "refresh-1",
      expires: Date.now() + 3_600_000,
    };
    const oauth = {
      refresh: vi.fn(async (credential: OAuthCredential) => {
        expect(credential.refresh).toBe("refresh-0");
        await gate;
        return rotated;
      }),
      toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
    };
    const pending = [
      background!.refreshExpiredModelCredential(clients[0]!, secrets, scope, stored.id, provider, {
        oauth,
      }),
      runStart!.resolveStoredModelAuth(clients[1]!, secrets, scope, stored.id, provider, {
        oauth,
        plaintext,
      }),
      runtime!.resolveStoredModelAuth(clients[2]!, secrets, scope, stored.id, provider, {
        oauth,
        // Match the SDK's authoritative expiry check inside credential-store modify.
        modify: async (current) =>
          current.expires - Date.now() < 300_000 ? oauth.refresh(current) : undefined,
      }),
    ] as const;
    const settled = Promise.allSettled(pending);
    try {
      // All contenders must reach the real DB lock before the token is issued.
      await vi.waitFor(
        async () => {
          const waiting = await monitor.pool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_locks
           WHERE locktype = 'advisory' AND NOT granted
             AND classid = hashtext('model-oauth-refresh')::oid
             AND objid = hashtext($1)::oid`,
            [JSON.stringify([id, provider])],
          );
          expect(waiting.rows[0]?.count).toBe(2);
        },
        { timeout: 5_000 },
      );
      expect(oauth.refresh).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await settled;
    }
    const [, startResult, runtimeResult] = await Promise.all(pending);
    expect(startResult?.apiKey).toBe("access-1");
    expect(runtimeResult?.apiKey).toBe("access-1");
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    const row = await prisma.secret.findUniqueOrThrow({ where: { id: stored.id } });
    expect(background!.parseModelSecret(await secrets.load(row.ciphertext, row.id))).toEqual({
      kind: "oauth",
      credential: rotated,
    });
  });
});
