// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  checkSpending,
  claimWalletPageInTransaction,
  confirmSpending,
  readSpendingLimit,
  releaseSpending,
  reserveSpending,
  setSpendingLimit,
  spendingPeriodStart,
} from "./spending-limit.js";
import { fakeSpendingPrisma } from "./spending-limit.test-support.js";

const today = new Date("2026-11-05T12:00:00Z");
const limit = { amount: 100, currency: "PLN", period: "monthly" } as const;

describe("account spending", () => {
  let fixture: ReturnType<typeof fakeSpendingPrisma>;
  let prisma: PrismaClient;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(today);
    fixture = fakeSpendingPrisma();
    prisma = fixture.prisma as unknown as PrismaClient;
  });
  afterEach(() => vi.useRealTimers());

  const reserve = (operationKey: string, amount: number | null, currency: string | null = "PLN") =>
    reserveSpending(prisma, { userId: "owner", operationKey, amount, currency });
  const claim = (walletKey: string, pageKey: string) =>
    prisma.$transaction((tx) => claimWalletPageInTransaction(tx, "owner", walletKey, pageKey));

  it("binds a wallet reservation to its first checkout and preserves that checkout on replay", async () => {
    await reserve("wallet:one", 50);
    expect(await claim("wallet:one", "page:first")).toBe(true);
    expect(await claim("wallet:one", "page:first")).toBe(true);
    expect(await claim("wallet:one", "page:second")).toBe(false);
    expect([...fixture.ledger.values()][0]?.pageOperationKey).toBe("page:first");
  });

  it("keeps a wallet's first checkout binding after confirming it", async () => {
    await reserve("wallet:one", 50);
    await claim("wallet:one", "page:first");
    await confirmSpending(prisma, "owner", "wallet:one");
    expect(await claim("wallet:one", "page:first")).toBe(true);
    expect(await claim("wallet:one", "page:second")).toBe(false);
  });

  it("cannot claim a missing, released or another user's wallet reservation", async () => {
    expect(await claim("missing", "page:first")).toBe(false);
    await reserveSpending(prisma, {
      userId: "other",
      operationKey: "wallet:other",
      amount: 50,
      currency: "PLN",
    });
    expect(await claim("wallet:other", "page:first")).toBe(false);
    await reserve("wallet:one", 50);
    await releaseSpending(prisma, "owner", "wallet:one");
    expect(await claim("wallet:one", "page:first")).toBe(false);
  });

  it.each([
    ["daily", "2026-11-05T00:00:00.000Z"],
    ["weekly", "2026-11-02T00:00:00.000Z"],
    ["monthly", "2026-11-01T00:00:00.000Z"],
    ["never", null],
  ] as const)("uses the %s UTC boundary", (period, expected) => {
    expect(spendingPeriodStart(period, today)?.toISOString() ?? null).toBe(expected);
  });

  it("keeps Sunday in the preceding Monday's week", () => {
    expect(spendingPeriodStart("weekly", new Date("2027-01-03T23:59:59Z"))?.toISOString()).toBe(
      "2026-12-28T00:00:00.000Z",
    );
  });

  it.each(["USD", "EUR", "GBP", "ILS", "PLN"] as const)(
    "saves a budget in %s",
    async (currency) => {
      expect(await setSpendingLimit(prisma, "owner", { ...limit, currency })).toEqual({
        limit: { ...limit, currency },
        spent: 0,
      });
    },
  );

  it("records known spend even while no budget is configured", async () => {
    expect(await reserve("one", 30)).toEqual({ allowed: true });
    await confirmSpending(prisma, "owner", "one");
    expect(await readSpendingLimit(prisma, "owner")).toEqual({ limit: null, spent: 0 });
    expect(await setSpendingLimit(prisma, "owner", limit)).toEqual({ limit, spent: 30 });
  });

  it("does not reserve while displaying a consent card and rechecks before paying", async () => {
    await setSpendingLimit(prisma, "owner", limit);
    expect(await checkSpending(prisma, { userId: "owner", amount: 70, currency: "PLN" })).toEqual({
      allowed: true,
    });
    expect(fixture.ledger.size).toBe(0);
    await reserve("other-bot", 50);
    expect(await reserve("waiting-consent", 70)).toEqual({ allowed: false, reason: "limit" });
    expect(fixture.ledger.size).toBe(1);
  });

  it("uses decimal arithmetic at an exact boundary", async () => {
    await setSpendingLimit(prisma, "owner", { ...limit, amount: 0.3 });
    await reserve("one", 0.1);
    expect(await reserve("two", 0.2)).toEqual({ allowed: true });
    expect(await reserve("three", 0.01)).toEqual({ allowed: false, reason: "limit" });
    expect((await readSpendingLimit(prisma, "owner")).spent).toBe(0.3);
  });

  it("keeps all bots' reservations while isolating another account", async () => {
    await setSpendingLimit(prisma, "owner", limit);
    await reserve("bot-a", 60);
    expect(await reserve("bot-b", 41)).toEqual({ allowed: false, reason: "limit" });
    expect(
      await reserveSpending(prisma, {
        userId: "other",
        operationKey: "bot-b",
        amount: 200,
        currency: "PLN",
      }),
    ).toEqual({ allowed: true });
    expect((await readSpendingLimit(prisma, "owner")).spent).toBe(60);
  });

  it.each([
    [null, "PLN", "unreadable"],
    [10, null, "unreadable"],
    [Number.NaN, "PLN", "unreadable"],
    [1.001, "PLN", "unreadable"],
    [-1, "PLN", "unreadable"],
    [1, "USD", "currency"],
  ] as const)("denies unreadable or mismatched input %s/%s", async (amount, currency, reason) => {
    await setSpendingLimit(prisma, "owner", limit);
    expect(await reserve("one", amount, currency)).toEqual({ allowed: false, reason });
    expect(fixture.ledger.size).toBe(0);
  });

  it("a zero limit refuses positive spend", async () => {
    await setSpendingLimit(prisma, "owner", { ...limit, amount: 0 });
    expect(await reserve("one", 0.01)).toEqual({ allowed: false, reason: "limit" });
  });

  it("rechecks an existing reservation without double-counting it", async () => {
    await setSpendingLimit(prisma, "owner", limit);
    await reserve("same", 70);
    expect(await reserve("same", 70)).toEqual({ allowed: true });
    expect((await readSpendingLimit(prisma, "owner")).spent).toBe(70);
    await setSpendingLimit(prisma, "owner", { ...limit, amount: 60 });
    expect(await reserve("same", 70)).toEqual({ allowed: false, reason: "limit" });
  });

  it("refuses a changed amount or currency on an existing operation", async () => {
    await reserve("same", 30);
    expect(await reserve("same", 20)).toEqual({ allowed: false, reason: "unreadable" });
    expect(await reserve("same", 30, "USD")).toEqual({ allowed: false, reason: "unreadable" });
  });

  it("refuses changed or released operations before displaying their approval card", async () => {
    await reserve("same", 30);
    expect(
      await checkSpending(prisma, {
        userId: "owner",
        operationKey: "same",
        amount: 20,
        currency: "PLN",
      }),
    ).toEqual({ allowed: false, reason: "unreadable" });
    await releaseSpending(prisma, "owner", "same");
    expect(
      await checkSpending(prisma, {
        userId: "owner",
        operationKey: "same",
        amount: 30,
        currency: "PLN",
      }),
    ).toEqual({ allowed: false, reason: "released" });
  });

  it("allows an unreadable page for an existing wallet only while no limit is set", async () => {
    await reserve("wallet", 30);
    const check = () =>
      checkSpending(prisma, {
        userId: "owner",
        operationKey: "wallet",
        amount: null,
        currency: null,
      });
    expect(await check()).toEqual({ allowed: true });
    await setSpendingLimit(prisma, "owner", limit);
    expect(await check()).toEqual({ allowed: false, reason: "unreadable" });
  });

  it("does not reset spend when a limit is edited, removed or restored", async () => {
    await reserve("one", 40);
    await confirmSpending(prisma, "owner", "one");
    await setSpendingLimit(prisma, "owner", limit);
    await setSpendingLimit(prisma, "owner", null);
    expect(await setSpendingLimit(prisma, "owner", { ...limit, amount: 50 })).toEqual({
      limit: { ...limit, amount: 50 },
      spent: 40,
    });
  });

  it("releases rejected, expired or failed outcomes idempotently", async () => {
    await setSpendingLimit(prisma, "owner", limit);
    await reserve("failed", 80);
    await releaseSpending(prisma, "owner", "failed");
    await releaseSpending(prisma, "owner", "failed");
    expect((await readSpendingLimit(prisma, "owner")).spent).toBe(0);
    expect(await reserve("failed", 80)).toEqual({ allowed: false, reason: "released" });
    expect(await reserve("new", 100)).toEqual({ allowed: true });
  });

  it("releases an approval later reported as failed and never revives it", async () => {
    await reserve("failed", 80);
    await confirmSpending(prisma, "owner", "failed");
    await releaseSpending(prisma, "owner", "failed");
    await confirmSpending(prisma, "owner", "failed");
    expect([...fixture.ledger.values()][0]?.status).toBe("released");
  });

  it("does not change a confirmed timestamp on replay", async () => {
    await reserve("one", 50);
    await confirmSpending(prisma, "owner", "one");
    vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
    await confirmSpending(prisma, "owner", "one");
    await reserve("one", 50);
    expect([...fixture.ledger.values()][0]?.countedAt).toEqual(today);
  });

  it("keeps outstanding reservations across reset but drops old confirmed spend", async () => {
    await setSpendingLimit(prisma, "owner", { ...limit, period: "daily" });
    await reserve("paid", 40);
    await confirmSpending(prisma, "owner", "paid");
    await reserve("not-yet-paid", 50);
    vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
    expect((await readSpendingLimit(prisma, "owner")).spent).toBe(50);
    expect(await reserve("another", 51)).toEqual({ allowed: false, reason: "limit" });
    await confirmSpending(prisma, "owner", "not-yet-paid");
    expect((await readSpendingLimit(prisma, "owner")).spent).toBe(50);
  });

  it("keeps unreadable payments fail-closed when a budget is enabled later", async () => {
    expect(await reserve("unknown", null, null)).toEqual({ allowed: true });
    await confirmSpending(prisma, "owner", "unknown");
    await setSpendingLimit(prisma, "owner", { ...limit, period: "daily" });
    expect(await reserve("new", 1)).toEqual({ allowed: false, reason: "unreadable" });
    vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
    expect(await reserve("new", 1)).toEqual({ allowed: true });
  });

  it("does not ignore an outstanding reservation in another currency", async () => {
    await reserve("other-currency", 30, "USD");
    await setSpendingLimit(prisma, "owner", limit);
    expect(await reserve("new", 1)).toEqual({ allowed: false, reason: "unreadable" });
    await releaseSpending(prisma, "owner", "other-currency");
    expect(await reserve("new", 1)).toEqual({ allowed: true });
  });

  it("refuses malformed stored budgets instead of turning the guard off", async () => {
    await setSpendingLimit(prisma, "owner", limit);
    const row = fixture.limits.get("owner")!;
    row.period = "invalid";
    await expect(reserve("one", 10)).rejects.toThrow("Invalid stored");
    row.period = "daily";
    row.amount = new Prisma.Decimal(-1);
    await expect(reserve("one", 10)).rejects.toThrow("Invalid stored");
  });
});
