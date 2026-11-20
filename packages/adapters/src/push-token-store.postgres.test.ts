// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited database fixtures are preserved; multi-device push coverage is an Ork addition.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDb, createPool, runAsSystem, runAsTenant } from "@orkbot/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { credentialDigest } from "./credential-digest.js";
import { PrismaPushTokenStore, PushSessionEndedError } from "./push-token-store.js";
import { EncryptedSecretStore } from "./secrets.js";

const suite =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
suite("database push registrations", () => {
  let a: ReturnType<typeof createDb>;
  let b: ReturnType<typeof createDb>;
  let api: PrismaPushTokenStore;
  let worker: PrismaPushTokenStore;
  const prefix = `push-fixture-${randomUUID()}`;
  const user = (id: string) => `${prefix}-${id}`;
  const session = (id: string) => `${prefix}-session-${id}`;
  const token = (id: string) => `ExponentPushToken[${prefix}-${id}]`;
  beforeAll(async () => {
    a = createDb(process.env.DATABASE_URL!);
    b = createDb(process.env.DATABASE_URL!);
    api = new PrismaPushTokenStore(a.prisma, "offline-push-encryption-key");
    worker = new PrismaPushTokenStore(b.prisma, "offline-push-encryption-key");
    await runAsSystem("seed push registration fixtures", async () => {
      for (const id of ["a", "b", "c"]) {
        await a.prisma.user.create({
          data: { id: user(id), name: "Fixture", email: `${user(id)}@example.invalid` },
        });
        await a.prisma.session.create({
          data: {
            id: session(id),
            token: session(id),
            userId: user(id),
            expiresAt: new Date(Date.now() + 3600_000),
          },
        });
      }
      await a.prisma.session.create({
        data: {
          id: session("a2"),
          token: session("a2"),
          userId: user("a"),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
    });
  });
  beforeEach(async () => {
    await runAsSystem("clear fixture push registrations", async () => {
      await a.prisma.pushToken.deleteMany({ where: { userId: { startsWith: prefix } } });
      await a.prisma.pushRegistration.deleteMany({ where: { userId: { startsWith: prefix } } });
      await a.prisma.session.updateMany({
        where: { userId: { startsWith: prefix } },
        data: { expiresAt: new Date(Date.now() + 3600_000) },
      });
    });
  });
  afterAll(async () => {
    if (!a) return;
    await runAsSystem("remove push registration fixtures", () =>
      a.prisma.user.deleteMany({ where: { id: { startsWith: prefix } } }),
    );
    await Promise.all([a.pool.end(), b.pool.end()]);
  });

  it("shares encrypted registrations across independent connections and restricts row access", async () => {
    await api.save(user("a"), token("a"), session("a"));
    expect(await worker.load(user("a"))).toEqual({ token: token("a"), sessionId: session("a") });
    const row = await runAsSystem("inspect fixture ciphertext", () =>
      a.prisma.pushToken.findUniqueOrThrow({ where: { userId: user("a") } }),
    );
    expect(row.ciphertext).not.toContain(token("a"));
    expect(row.tokenDigest).toBe(credentialDigest(token("a")));
    await runAsTenant({ userId: user("b"), spaceId: "unused" }, async () => {
      expect(await a.prisma.pushToken.findMany()).toEqual([]);
      expect(await a.prisma.pushRegistration.findMany()).toEqual([]);
    });
  });

  it("keeps the native presentation capability across replicas and clears it on legacy registration", async () => {
    await api.save(user("a"), token("a"), session("a"), "android_sender");
    expect((await worker.load(user("a")))?.presentation).toBe("android_sender");
    await api.save(user("a"), token("a"), session("a"));
    expect((await worker.load(user("a")))?.presentation).toBeUndefined();
  });

  it("serializes concurrent device handovers so only one account owns a token", async () => {
    await Promise.all([
      api.save(user("a"), token("shared"), session("a")),
      worker.save(user("b"), token("shared"), session("b")),
      api.save(user("c"), token("shared"), session("c")),
    ]);
    const registrations = await Promise.all([
      api.load(user("a")),
      worker.load(user("b")),
      api.load(user("c")),
    ]);
    expect(registrations.filter(Boolean)).toHaveLength(1);
  });

  it("keeps newer registrations when an old receipt or logout arrives", async () => {
    await api.save(user("a"), token("a"), session("a"));
    await worker.save(user("a"), token("new"), session("a2"));
    await api.remove(user("a"), credentialDigest(token("a")));
    await api.endSession(user("a"), session("a"));
    expect((await worker.load(user("a")))?.token).toBe(token("new"));
    await api.remove(user("a"), credentialDigest(token("new")));
    expect(await worker.load(user("a"))).toBeUndefined();
  });

  it("retargets only the replaced session and cannot reclaim a handed-over device", async () => {
    await api.save(user("a"), token("shared"), session("a"));
    await worker.endSession(user("a"), session("a"), session("a2"));
    await api.endSession(user("a"), session("a"));
    expect((await worker.load(user("a")))?.sessionId).toBe(session("a2"));
    await worker.save(user("b"), token("shared"), session("b"));
    await api.endSession(user("a"), session("a2"), session("a"));
    expect(await api.load(user("a"))).toBeUndefined();
    expect((await worker.load(user("b")))?.token).toBe(token("shared"));
  });

  it("imports only unclaimed devices and accounts, including concurrent imports", async () => {
    await api.save(user("b"), token("owned"), session("b"));
    expect(await worker.importLegacy(user("a"), token("owned"), session("a"))).toBe(false);
    expect(await worker.load(user("a"))).toBeUndefined();
    expect((await api.load(user("b")))?.token).toBe(token("owned"));
    expect(await worker.importLegacy(user("b"), token("stale"), session("b"))).toBe(false);
    expect((await api.load(user("b")))?.token).toBe(token("owned"));
    const imported = await Promise.all([
      api.importLegacy(user("a"), token("unclaimed"), session("a")),
      worker.importLegacy(user("c"), token("unclaimed"), session("c")),
    ]);
    expect(imported.filter(Boolean)).toHaveLength(1);
  });

  it("lets authenticated registration win a race with legacy import", async () => {
    await Promise.all([
      api.importLegacy(user("a"), token("racing"), session("a")),
      worker.save(user("b"), token("racing"), session("b")),
    ]);
    expect(await api.load(user("a"))).toBeUndefined();
    expect((await worker.load(user("b")))?.token).toBe(token("racing"));
  });

  it("rejects expired, missing and another account's sessions without stealing tokens", async () => {
    await api.save(user("a"), token("shared"), session("a"));
    for (const invalid of [session("missing"), session("a")])
      await expect(worker.save(user("b"), token("shared"), invalid)).rejects.toBeInstanceOf(
        PushSessionEndedError,
      );
    await runAsSystem("expire fixture session", () =>
      a.prisma.session.update({ where: { id: session("c") }, data: { expiresAt: new Date(0) } }),
    );
    await expect(worker.save(user("c"), token("shared"), session("c"))).rejects.toBeInstanceOf(
      PushSessionEndedError,
    );
    expect((await api.load(user("a")))?.token).toBe(token("shared"));
  });

  it("retains two devices, replaces only the rotating session, and revokes only its registration", async () => {
    await api.save(user("a"), token("first"), session("a"));
    await worker.save(user("a"), token("second"), session("a2"));
    expect((await api.list(user("a"))).map((row) => row.token).sort()).toEqual(
      [token("first"), token("second")].sort(),
    );
    await api.save(user("a"), token("rotated"), session("a"));
    expect((await worker.list(user("a"))).map((row) => row.token).sort()).toEqual(
      [token("rotated"), token("second")].sort(),
    );
    await api.remove(user("a"), credentialDigest(token("first")));
    expect(await worker.list(user("a"))).toHaveLength(2);
    await api.endSession(user("a"), session("a"));
    expect(await worker.list(user("a"))).toEqual([
      { token: token("second"), sessionId: session("a2") },
    ]);
    expect(
      await runAsSystem("legacy worker view", () =>
        a.prisma.pushToken.findUnique({ where: { userId: user("a") } }),
      ),
    ).toMatchObject({ sessionId: session("a2") });
  });

  it("keeps a registration already made by the replacement session", async () => {
    await api.save(user("a"), token("old"), session("a"));
    await worker.save(user("a"), token("new"), session("a2"));
    await api.endSession(user("a"), session("a"), session("a2"));
    expect(await worker.list(user("a"))).toEqual([
      { token: token("new"), sessionId: session("a2") },
    ]);
  });

  it("mirrors older-node registrations and conditional removal without reviving stale tokens", async () => {
    await api.save(user("a"), token("first"), session("a"));
    const row = await runAsSystem("legacy node view", () =>
      a.prisma.pushToken.findUniqueOrThrow({ where: { userId: user("a") } }),
    );
    await runAsSystem("old node registers another device", () =>
      a.prisma.pushToken.update({
        where: { userId: user("a") },
        data: {
          sessionId: session("a2"),
          tokenDigest: credentialDigest(token("second")),
          ciphertext: row.ciphertext,
        },
      }),
    );
    // Ciphertext is copied unchanged by the mirror, never decrypted in SQL.
    expect(
      await runAsSystem("inspect mirrored devices", () =>
        a.prisma.pushRegistration.count({ where: { userId: user("a") } }),
      ),
    ).toBe(2);
    await api.save(user("a"), token("rotated"), session("a2"));
    const newRow = await runAsSystem("inspect rotated fixture", () =>
      a.prisma.pushToken.findUniqueOrThrow({ where: { userId: user("a") } }),
    );
    // An old snapshot timestamp cannot overwrite the session's newer registration.
    await runAsSystem("late legacy snapshot", () =>
      a.prisma.pushToken.update({
        where: { userId: user("a") },
        data: {
          tokenDigest: row.tokenDigest,
          ciphertext: row.ciphertext,
          updatedAt: new Date(row.updatedAt.getTime() - 1),
        },
      }),
    );
    expect(
      await runAsSystem("inspect guarded rotation", () =>
        a.prisma.pushRegistration.findUnique({ where: { tokenDigest: newRow.tokenDigest } }),
      ),
    ).not.toBeNull();
    await runAsSystem("old node deletes stale snapshot", () =>
      a.prisma.pushToken.delete({ where: { userId: user("a") } }),
    );
    expect((await worker.list(user("a"))).map((entry) => entry.token).sort()).toEqual(
      [token("first"), token("rotated")].sort(),
    );
  });

  it("backfills ciphertext and encryption context from the previous schema without keys in SQL", async () => {
    await api.save(user("a"), token("migrated"), session("a"));
    const owner = createPool(process.env.DATABASE_MIGRATION_URL!);
    const client = await owner.connect();
    try {
      await client.query("begin");
      await client.query(
        "DROP TRIGGER mirror_legacy_push_registration ON push_tokens; DROP FUNCTION mirror_legacy_push_registration(); DROP TABLE push_registrations",
      );
      const sql = readFileSync(
        new URL(
          "../../db/prisma/migrations/20261130135000_push_registrations/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await client.query(sql.replace(/^BEGIN;\n/m, "").replace(/^COMMIT;\n/m, ""));
      const { rows } = await client.query<{ ciphertext: string }>(
        'SELECT ciphertext FROM push_registrations WHERE "userId" = $1',
        [user("a")],
      );
      expect(rows).toHaveLength(1);
      expect(
        await new EncryptedSecretStore("offline-push-encryption-key").load(
          rows[0]!.ciphertext,
          `push-token:${user("a")}`,
        ),
      ).toBe(token("migrated"));
    } finally {
      await client.query("rollback");
      client.release();
      await owner.end();
    }
  });

  it("cascades all registrations when the account is deleted", async () => {
    const id = user("deleted");
    await runAsSystem("seed deleted account fixture", async () => {
      await a.prisma.user.create({ data: { id, name: "Fixture", email: `${id}@example.invalid` } });
      for (const device of ["one", "two"])
        await a.prisma.session.create({
          data: {
            id: session(`deleted-${device}`),
            token: session(`deleted-${device}`),
            userId: id,
            expiresAt: new Date(Date.now() + 3600_000),
          },
        });
    });
    await api.save(id, token("deleted-one"), session("deleted-one"));
    await worker.save(id, token("deleted-two"), session("deleted-two"));
    expect(await worker.list(id)).toHaveLength(2);
    await runAsSystem("delete account fixture", () => a.prisma.user.delete({ where: { id } }));
    expect(await worker.list(id)).toEqual([]);
  });

  it("does not publish a registration after a concurrent session deletion commits", async () => {
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deletion = runAsSystem("delete fixture session concurrently", () =>
      a.prisma.$transaction(async (tx) => {
        await tx.session.delete({ where: { id: session("a2") } });
        locked();
        await hold;
      }),
    );
    await ready;
    const registering = worker.save(user("a"), token("late"), session("a2"));
    // Attach rejection handling before releasing the blocked registration.
    const rejected = expect(registering).rejects.toBeInstanceOf(PushSessionEndedError);
    release();
    await deletion;
    await rejected;
    expect(await api.load(user("a"))).toBeUndefined();
  });
});
