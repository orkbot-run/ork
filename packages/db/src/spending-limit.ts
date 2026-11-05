// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { SpendingLimit, SpendingLimitState, SpendingPeriod } from "@orkbot/contracts";
import { MAX_SPENDING_AMOUNT, SpendingLimitSchema } from "@orkbot/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

export type SpendingLimitValue = SpendingLimit;
export type SpendingLimitView = SpendingLimitState;
export type SpendingDecision =
  | { allowed: true }
  | { allowed: false; reason: "limit" | "currency" | "unreadable" | "released" };
export type SpendingInput = {
  userId: string;
  operationKey: string;
  amount: number | null;
  currency: string | null;
};
export type SpendingCheckInput = Omit<SpendingInput, "operationKey"> & { operationKey?: string };
export type SpendingTx = Pick<
  Prisma.TransactionClient,
  "$queryRaw" | "accountSpendingLimit" | "paymentLedgerEntry"
>;
type SpendingDb = Pick<PrismaClient, "$transaction">;

/** UTC calendar boundaries, with Monday as the first day of a week. */
export function spendingPeriodStart(period: SpendingPeriod, now: Date): Date | null {
  if (period === "never") return null;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "monthly") start.setUTCDate(1);
  else if (period === "weekly")
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start;
}

/** Every budget mutation and payment check uses the same account lock, across all Spaces. */
export async function lockSpending(
  tx: Pick<SpendingTx, "$queryRaw">,
  userId: string,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`account-spending:${userId}`}, 0))::text AS "lock"
  `);
}

function money(amount: number | null): Prisma.Decimal | null {
  if (amount === null || !Number.isFinite(amount) || amount < 0 || amount > MAX_SPENDING_AMOUNT)
    return null;
  const value = new Prisma.Decimal(amount);
  return value.decimalPlaces() <= 2 ? value : null;
}

function storedLimit(row: {
  amount: Prisma.Decimal;
  currency: string;
  period: string;
}): SpendingLimitValue {
  const amount = row.amount.toNumber();
  const parsed = SpendingLimitSchema.safeParse({
    amount,
    currency: row.currency,
    period: row.period,
  });
  if (!parsed.success) throw new Error("Invalid stored account spending limit");
  return parsed.data;
}

function activeWhere(userId: string, since: Date | null, operationKey?: string) {
  return {
    userId,
    ...(operationKey ? { operationKey: { not: operationKey } } : {}),
    OR: [
      { status: "reserved" },
      { status: "confirmed", ...(since ? { countedAt: { gte: since } } : {}) },
    ],
  } satisfies Prisma.PaymentLedgerEntryWhereInput;
}

async function spentInTransaction(
  tx: SpendingTx,
  userId: string,
  limit: SpendingLimitValue,
  now: Date,
) {
  const total = await tx.paymentLedgerEntry.aggregate({
    where: {
      ...activeWhere(userId, spendingPeriodStart(limit.period, now)),
      currency: limit.currency,
    },
    _sum: { amount: true },
  });
  return total._sum.amount ?? new Prisma.Decimal(0);
}

async function readInTransaction(
  tx: SpendingTx,
  userId: string,
  now: Date,
): Promise<SpendingLimitView> {
  const row = await tx.accountSpendingLimit.findUnique({ where: { userId } });
  if (!row) return { limit: null, spent: 0 };
  const limit = storedLimit(row);
  return { limit, spent: (await spentInTransaction(tx, userId, limit, now)).toNumber() };
}

export function readSpendingLimit(prisma: SpendingDb, userId: string): Promise<SpendingLimitView> {
  return prisma.$transaction(async (tx) => {
    await lockSpending(tx, userId);
    return readInTransaction(tx, userId, new Date());
  });
}

/** Editing or removing a limit never removes the account's payment history. */
export function setSpendingLimit(
  prisma: SpendingDb,
  userId: string,
  limit: SpendingLimitValue | null,
): Promise<SpendingLimitView> {
  if (limit && !SpendingLimitSchema.safeParse(limit).success)
    throw new Error("Invalid account spending limit");
  return prisma.$transaction(async (tx) => {
    await lockSpending(tx, userId);
    if (limit) {
      await tx.accountSpendingLimit.upsert({
        where: { userId },
        create: { userId, ...limit },
        update: limit,
      });
    } else await tx.accountSpendingLimit.deleteMany({ where: { userId } });
    return readInTransaction(tx, userId, new Date());
  });
}

async function checkInTransaction(
  tx: SpendingTx,
  input: SpendingCheckInput,
  now: Date,
): Promise<SpendingDecision> {
  const row = await tx.accountSpendingLimit.findUnique({ where: { userId: input.userId } });
  if (!row) return { allowed: true };
  const limit = storedLimit(row);
  const amount = money(input.amount);
  if (!amount || !input.currency) return { allowed: false, reason: "unreadable" };
  if (input.currency !== limit.currency) return { allowed: false, reason: "currency" };
  const where = activeWhere(
    input.userId,
    spendingPeriodStart(limit.period, now),
    input.operationKey,
  );
  // Unknown outstanding payments cannot be silently ignored after a limit is enabled.
  const unknown = await tx.paymentLedgerEntry.findFirst({
    where: {
      AND: [
        where,
        { OR: [{ amount: null }, { status: "reserved", currency: { not: limit.currency } }] },
      ],
    },
    select: { id: true },
  });
  if (unknown) return { allowed: false, reason: "unreadable" };
  const total = await tx.paymentLedgerEntry.aggregate({
    where: { ...where, currency: limit.currency },
    _sum: { amount: true },
  });
  return amount.plus(total._sum.amount ?? 0).gt(limit.amount)
    ? { allowed: false, reason: "limit" }
    : { allowed: true };
}

function existingDecision(
  existing: { amount: Prisma.Decimal | null; currency: string | null; status: string } | null,
  input: SpendingCheckInput,
): SpendingDecision | undefined {
  if (existing?.status === "released") return { allowed: false, reason: "released" };
  const amount = money(input.amount);
  if (
    existing?.amount !== null &&
    existing?.amount !== undefined &&
    (!amount || !existing.amount.eq(amount) || existing.currency !== input.currency)
  )
    return { allowed: false, reason: "unreadable" };
  return undefined;
}

export async function checkSpendingInTransaction(
  tx: SpendingTx,
  input: SpendingCheckInput,
): Promise<SpendingDecision> {
  await lockSpending(tx, input.userId);
  const existing = input.operationKey
    ? await tx.paymentLedgerEntry.findUnique({
        where: { userId_operationKey: { userId: input.userId, operationKey: input.operationKey } },
      })
    : null;
  const refused = existingDecision(existing, input);
  if (
    refused &&
    !refused.allowed &&
    (refused.reason === "released" || (input.amount !== null && input.currency !== null))
  )
    return refused;
  return checkInTransaction(tx, input, new Date());
}

/** The approval card is checked without holding budget while the user decides. */
export function checkSpending(
  prisma: SpendingDb,
  input: SpendingCheckInput,
): Promise<SpendingDecision> {
  return prisma.$transaction((tx) => checkSpendingInTransaction(tx, input));
}

/** Reserve immediately before exposing a card or paying; callers keep the operation key on replay. */
export async function reserveSpendingInTransaction(
  tx: SpendingTx,
  input: SpendingInput,
): Promise<SpendingDecision> {
  await lockSpending(tx, input.userId);
  const now = new Date();
  const existing = await tx.paymentLedgerEntry.findUnique({
    where: { userId_operationKey: { userId: input.userId, operationKey: input.operationKey } },
  });
  const refused = existingDecision(existing, input);
  if (refused) return refused;
  const amount = money(input.amount);
  const currency = amount && input.currency ? input.currency : null;
  // A completed effect is already counted and must not be charged twice on replay.
  if (existing?.status === "confirmed") return { allowed: true };
  const decision = await checkInTransaction(tx, input, now);
  if (!decision.allowed) return decision;
  const data = {
    amount: currency ? amount : null,
    currency,
    status: "reserved",
  };
  await tx.paymentLedgerEntry.upsert({
    where: { userId_operationKey: { userId: input.userId, operationKey: input.operationKey } },
    create: { userId: input.userId, operationKey: input.operationKey, countedAt: now, ...data },
    update: data,
  });
  return { allowed: true };
}

export function reserveSpending(
  prisma: SpendingDb,
  input: SpendingInput,
): Promise<SpendingDecision> {
  return prisma.$transaction((tx) => reserveSpendingInTransaction(tx, input));
}

/** One checkout effect can consume a wallet approval; a replay keeps that same association. */
export async function claimWalletPageInTransaction(
  tx: SpendingTx,
  userId: string,
  walletOperationKey: string,
  pageOperationKey: string,
): Promise<boolean> {
  await lockSpending(tx, userId);
  const claimed = await tx.paymentLedgerEntry.updateMany({
    where: {
      userId,
      operationKey: walletOperationKey,
      status: { in: ["reserved", "confirmed"] },
      OR: [{ pageOperationKey: null }, { pageOperationKey }],
    },
    data: { pageOperationKey },
  });
  return claimed.count > 0;
}

/** Confirm only a live reservation, atomically with the purchase's successful outcome. */
export async function confirmSpendingInTransaction(
  tx: SpendingTx,
  userId: string,
  operationKey: string,
): Promise<void> {
  await lockSpending(tx, userId);
  await tx.paymentLedgerEntry.updateMany({
    where: { userId, operationKey, status: "reserved" },
    data: { status: "confirmed", countedAt: new Date() },
  });
}

export function confirmSpending(
  prisma: SpendingDb,
  userId: string,
  operationKey: string,
): Promise<void> {
  return prisma.$transaction((tx) => confirmSpendingInTransaction(tx, userId, operationKey));
}

/** Known failures, rejection and expiration release even an earlier approval's reservation. */
export async function releaseSpendingInTransaction(
  tx: SpendingTx,
  userId: string,
  operationKey: string,
): Promise<void> {
  await lockSpending(tx, userId);
  await tx.paymentLedgerEntry.updateMany({
    where: { userId, operationKey, status: { in: ["reserved", "confirmed"] } },
    data: { status: "released" },
  });
}

export function releaseSpending(
  prisma: SpendingDb,
  userId: string,
  operationKey: string,
): Promise<void> {
  return prisma.$transaction((tx) => releaseSpendingInTransaction(tx, userId, operationKey));
}
