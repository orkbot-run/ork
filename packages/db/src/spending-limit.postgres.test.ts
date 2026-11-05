// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem, runAsTenant } from "./row-security.js";
import {
  checkSpending,
  claimWalletPageInTransaction,
  confirmSpendingInTransaction,
  readSpendingLimit,
  releaseSpendingInTransaction,
  reserveSpending,
  setSpendingLimit,
} from "./spending-limit.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

postgres("account spending reservations (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const ownerId = `spending-owner-${suffix}`;
  const otherId = `spending-other-${suffix}`;
  const first = { userId: ownerId, spaceId: `spending-first-${suffix}` };
  const second = { userId: ownerId, spaceId: `spending-second-${suffix}` };
  const other = { userId: otherId, spaceId: first.spaceId };
  const limit = { amount: 100, currency: "PLN", period: "monthly" } as const;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let fixtures: PrismaClient;

  beforeAll(async () => {
    db = createDb(databaseUrl!, { poolMax: 6 });
    prisma = db.prisma;
    fixtures = asSystem(prisma);
    for (const userId of [ownerId, otherId]) {
      await fixtures.user.create({
        data: { id: userId, name: "Spending fixture", email: `${userId}@example.test` },
      });
    }
  });

  beforeEach(async () => {
    await fixtures.paymentLedgerEntry.deleteMany({ where: { userId: { in: [ownerId, otherId] } } });
    await fixtures.accountSpendingLimit.deleteMany({
      where: { userId: { in: [ownerId, otherId] } },
    });
    await runAsTenant(first, () => setSpendingLimit(prisma, ownerId, limit));
  });

  afterAll(async () => {
    if (!db) return;
    await fixtures.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  const reserve = (operationKey: string, amount: number) =>
    reserveSpending(prisma, { userId: ownerId, operationKey, amount, currency: "PLN" });

  it("lets only one distinct checkout effect claim a racing wallet reservation", async () => {
    await runAsTenant(first, () => reserve("wallet:one", 50));
    const claim = (pageKey: string) =>
      prisma.$transaction((tx) => claimWalletPageInTransaction(tx, ownerId, "wallet:one", pageKey));
    const results = await Promise.all([
      runAsTenant(first, () => claim("page:first")),
      runAsTenant(second, () => claim("page:second")),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await fixtures.paymentLedgerEntry.findUniqueOrThrow({
      where: { userId_operationKey: { userId: ownerId, operationKey: "wallet:one" } },
    });
    expect(await runAsTenant(first, () => claim(row.pageOperationKey!))).toBe(true);
  });

  it("keeps a replayed checkout claim idempotent across workers", async () => {
    await runAsTenant(first, () => reserve("wallet:one", 50));
    const claim = () =>
      prisma.$transaction((tx) =>
        claimWalletPageInTransaction(tx, ownerId, "wallet:one", "page:same"),
      );
    expect(await Promise.all([runAsTenant(first, claim), runAsTenant(second, claim)])).toEqual([
      true,
      true,
    ]);
  });

  it("allows only one racing payment across two Spaces to consume the remaining budget", async () => {
    const results = await Promise.all([
      runAsTenant(first, () => reserve("first-bot", 70)),
      runAsTenant(second, () => reserve("second-bot", 70)),
    ]);
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(results.filter((result) => !result.allowed)).toEqual([
      { allowed: false, reason: "limit" },
    ]);
    expect(await runAsTenant(second, () => readSpendingLimit(prisma, ownerId))).toEqual({
      limit,
      spent: 70,
    });
  });

  it("does not duplicate a reservation when the same effect races on two workers", async () => {
    const results = await runAsTenant(first, () =>
      Promise.all([reserve("same", 70), reserve("same", 70)]),
    );
    expect(results).toEqual([{ allowed: true }, { allowed: true }]);
    expect(await fixtures.paymentLedgerEntry.count({ where: { userId: ownerId } })).toBe(1);
    expect((await runAsTenant(first, () => readSpendingLimit(prisma, ownerId))).spent).toBe(70);
  });

  it("rechecks a consent that another bot has made unaffordable", async () => {
    await runAsTenant(first, async () => {
      expect(await checkSpending(prisma, { userId: ownerId, amount: 70, currency: "PLN" })).toEqual(
        { allowed: true },
      );
    });
    await runAsTenant(second, () => reserve("other-bot", 40));
    expect(await runAsTenant(first, () => reserve("approved-consent", 70))).toEqual({
      allowed: false,
      reason: "limit",
    });
  });

  it("rolls a reservation confirmation back with its enclosing transaction", async () => {
    await runAsTenant(first, () => reserve("rollback", 70));
    await expect(
      runAsTenant(first, () =>
        prisma.$transaction(async (tx) => {
          await confirmSpendingInTransaction(tx, ownerId, "rollback");
          throw new Error("Rollback fixture");
        }),
      ),
    ).rejects.toThrow("Rollback fixture");
    expect(
      await fixtures.paymentLedgerEntry.findUnique({
        where: { userId_operationKey: { userId: ownerId, operationKey: "rollback" } },
      }),
    ).toMatchObject({ status: "reserved" });
  });

  it("atomically releases failed purchases so another payment can proceed", async () => {
    await runAsTenant(first, () => reserve("failure", 80));
    await runAsTenant(first, () =>
      prisma.$transaction(async (tx) => {
        await releaseSpendingInTransaction(tx, ownerId, "failure");
      }),
    );
    expect(await runAsTenant(second, () => reserve("replacement", 100))).toEqual({ allowed: true });
  });

  it("does not expose another account's budget or ledger through the same Space", async () => {
    await runAsTenant(first, () => reserve("private", 30));
    expect(
      await runAsTenant(other, () =>
        prisma.accountSpendingLimit.findMany({ where: { userId: ownerId } }),
      ),
    ).toEqual([]);
    expect(
      await runAsTenant(other, () =>
        prisma.paymentLedgerEntry.findMany({ where: { userId: ownerId } }),
      ),
    ).toEqual([]);
    await expect(
      runAsTenant(other, () => setSpendingLimit(prisma, ownerId, { ...limit, amount: 1000 })),
    ).rejects.toThrow();
  });

  it("lets another account pay while the first account's advisory lock is held", async () => {
    let acquired!: () => void;
    let finish!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const firstPayment = runAsTenant(first, () =>
      prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account-spending:${ownerId}`}, 0))::text`;
          acquired();
          await release;
        },
        { timeout: 15_000 },
      ),
    );
    await locked;
    try {
      const result = await runAsTenant(other, () =>
        reserveSpending(prisma, {
          userId: otherId,
          operationKey: "independent",
          amount: 100,
          currency: "PLN",
        }),
      );
      expect(result).toEqual({ allowed: true });
    } finally {
      finish();
      await firstPayment;
    }
  });
});
