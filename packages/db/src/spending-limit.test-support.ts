// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { vi } from "vitest";
import type { AccountSpendingLimit, PaymentLedgerEntry } from "./client.js";
import { Prisma } from "./client.js";

type Filter = Record<string, unknown>;

function matches(row: object, where: Filter): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "AND") return (expected as Filter[]).every((part) => matches(row, part));
    if (key === "OR") return (expected as Filter[]).some((part) => matches(row, part));
    const actual = (row as Filter)[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, value]) => {
        if (operator === "not") return actual !== value;
        if (operator === "in") return (value as unknown[]).includes(actual);
        if (operator === "gte") return (actual as Date) >= (value as Date);
        throw new Error(`Unsupported spending fixture operator: ${operator}`);
      });
    }
    return actual === expected;
  });
}

/** Budget delegates for deterministic purchase tests; PostgreSQL suites prove real lock behavior. */
export function fakeSpendingPrisma() {
  const limits = new Map<string, AccountSpendingLimit>();
  const ledger = new Map<string, PaymentLedgerEntry>();
  const key = (owner: { userId: string; operationKey: string }) =>
    `${owner.userId}:${owner.operationKey}`;
  const delegates = {
    $queryRaw: vi.fn(async () => []),
    accountSpendingLimit: {
      findUnique: vi.fn(
        async ({ where }: { where: { userId: string } }) => limits.get(where.userId) ?? null,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { userId: string };
          create: { userId: string; amount: number; currency: string; period: string };
          update: { amount: number; currency: string; period: string };
        }) => {
          const previous = limits.get(where.userId);
          const next = previous ? { ...previous, ...update } : { ...create, createdAt: new Date() };
          const row = { ...next, amount: new Prisma.Decimal(next.amount), updatedAt: new Date() };
          limits.set(where.userId, row);
          return row;
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => ({
        count: Number(limits.delete(where.userId)),
      })),
    },
    paymentLedgerEntry: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { userId_operationKey: { userId: string; operationKey: string } };
        }) => ledger.get(key(where.userId_operationKey)) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Filter }) =>
          [...ledger.values()].find((row) => matches(row, where)) ?? null,
      ),
      aggregate: vi.fn(async ({ where }: { where: Filter }) => ({
        _sum: {
          amount: [...ledger.values()]
            .filter((row) => matches(row, where))
            .reduce((total, row) => total.plus(row.amount ?? 0), new Prisma.Decimal(0)),
        },
      })),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { userId_operationKey: { userId: string; operationKey: string } };
          create: Omit<
            PaymentLedgerEntry,
            "id" | "createdAt" | "updatedAt" | "pageOperationKey"
          > & { pageOperationKey?: string | null };
          update: Partial<PaymentLedgerEntry>;
        }) => {
          const id = key(where.userId_operationKey);
          const previous = ledger.get(id);
          const row = previous
            ? { ...previous, ...update, updatedAt: new Date() }
            : {
                pageOperationKey: null,
                ...create,
                id,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
          ledger.set(id, row);
          return row;
        },
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: Filter; data: Partial<PaymentLedgerEntry> }) => {
          let count = 0;
          for (const [id, row] of ledger) {
            if (!matches(row, where)) continue;
            ledger.set(id, { ...row, ...data, updatedAt: new Date() });
            count += 1;
          }
          return { count };
        },
      ),
    },
  };
  const prisma = {
    ...delegates,
    $transaction: vi.fn(
      async <T>(callback: (tx: typeof delegates) => Promise<T>): Promise<T> => callback(delegates),
    ),
  };
  return { prisma, limits, ledger };
}
