// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited fixtures remain Apache-2.0; ledger fixtures are PolyForm-covered.

import type {
  AdapterContext,
  AdapterDescriptor,
  BackgroundJob,
  HttpPaymentAuthorization,
  HttpPaymentChallenge,
  JobPublisher,
  PaymentCardSecret,
  PaymentWalletCapabilities,
  PaymentWalletProvider,
  PurchaseRequest,
  PurchaseSnapshot,
} from "@orkbot/adapter-kit";
import type { PrismaClient, Purchase } from "@orkbot/db";
import { Prisma } from "@orkbot/db";
import { readStripeChargeChallenge, stripeChargeAuthorization } from "./mpp-stripe.js";

export const FAKE_PAY_TOKEN = "fake_pay_token_secret";
export const FAKE_SHARED_PAYMENT_TOKEN = "spt_fake_secret";

/** A wallet whose purchase status a test sets directly. */
export class FakePaymentWallet implements PaymentWalletProvider {
  readonly displayName = "Fake Wallet";
  readonly created: PurchaseRequest[] = [];
  readonly snapshots = new Map<string, PurchaseSnapshot>();
  getError: Error | undefined;

  describe(): AdapterDescriptor<PaymentWalletCapabilities> {
    return {
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { offline: true, credentials: ["card", "pay_token", "http_payment"] },
    };
  }
  beginConnect(): never {
    throw new Error("unused");
  }
  pollConnect(): never {
    throw new Error("unused");
  }
  refresh(): never {
    throw new Error("unused");
  }
  async disconnect() {}
  async createPurchase(_credential: unknown, request: PurchaseRequest) {
    this.created.push(request);
    const id = `remote-${request.idempotencyKey}`;
    const snapshot: PurchaseSnapshot = this.snapshots.get(id) ?? {
      id,
      status: "pending_approval",
      approvalUrl: `https://wallet.example.test/approve/${id}`,
    };
    this.snapshots.set(id, snapshot);
    return snapshot;
  }
  async getPurchase(_credential: unknown, id: string, _context: AdapterContext) {
    if (this.getError) throw this.getError;
    return this.snapshots.get(id) ?? { id, status: "pending_approval" as const };
  }
  async revealCard(): Promise<PaymentCardSecret> {
    return { number: "4242424242424242", cvc: "123" };
  }
  async revealPayToken(): Promise<string> {
    return FAKE_PAY_TOKEN;
  }
  async readHttpPaymentChallenge(header: string): Promise<HttpPaymentChallenge | null> {
    return readStripeChargeChallenge(header);
  }
  async authorizeHttpPayment(
    _credential: unknown,
    _id: string,
    approved: string,
    header: string,
  ): Promise<HttpPaymentAuthorization> {
    return {
      headers: {
        authorization: await stripeChargeAuthorization(approved, header, FAKE_SHARED_PAYMENT_TOKEN),
      },
      secrets: [FAKE_SHARED_PAYMENT_TOKEN],
    };
  }
}

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "AND") return (expected as Row[]).every((branch) => matches(row, branch));
    if (key === "OR") return (expected as Row[]).some((branch) => matches(row, branch));
    const actual = row[key];
    if (expected && typeof expected === "object" && "startsWith" in expected)
      return typeof actual === "string" && actual.startsWith(String(expected.startsWith));
    if (expected && typeof expected === "object" && "in" in expected)
      return (expected.in as unknown[]).includes(actual);
    if (expected && typeof expected === "object" && "gt" in expected)
      return actual instanceof Date && actual > (expected.gt as Date);
    if (expected instanceof Date)
      return actual instanceof Date && actual.getTime() === expected.getTime();
    if (expected && typeof expected === "object" && "lte" in expected) {
      return actual instanceof Date && actual.getTime() <= (expected.lte as Date).getTime();
    }
    if (expected && typeof expected === "object" && "gte" in expected) {
      return actual instanceof Date && actual.getTime() >= (expected.gte as Date).getTime();
    }
    if (expected && typeof expected === "object" && "not" in expected) {
      return actual !== expected.not;
    }
    return actual === expected;
  });
}

/** Just the Prisma calls the purchase lifecycle makes, over in-memory rows. */
export function fakePurchasePrisma(fixture: {
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
}) {
  const purchases: Purchase[] = [];
  const limits = new Map<string, Row>();
  const ledger = new Map<string, Row>();
  const ledgerKey = (where: Row) => {
    const owner = where.userId_operationKey as { userId: string; operationKey: string };
    return `${owner.userId}:${owner.operationKey}`;
  };
  const spending = {
    $queryRaw: async () => [],
    accountSpendingLimit: {
      findUnique: async ({ where }: { where: Row }) => limits.get(String(where.userId)) ?? null,
      upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        const key = String(where.userId);
        const row = {
          ...(limits.has(key) ? limits.get(key) : create),
          ...update,
          amount: new Prisma.Decimal(Number(update.amount ?? create.amount)),
        };
        limits.set(key, row);
        return row;
      },
      deleteMany: async ({ where }: { where: Row }) => ({
        count: Number(limits.delete(String(where.userId))),
      }),
    },
    paymentLedgerEntry: {
      findUnique: async ({ where }: { where: Row }) => ledger.get(ledgerKey(where)) ?? null,
      findFirst: async ({ where }: { where: Row }) =>
        [...ledger.values()].find((row) => matches(row, where)) ?? null,
      aggregate: async ({ where }: { where: Row }) => ({
        _sum: {
          amount: [...ledger.values()]
            .filter((row) => matches(row, where))
            .reduce(
              (total, row) => total.plus((row.amount as Prisma.Decimal) ?? 0),
              new Prisma.Decimal(0),
            ),
        },
      }),
      upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        const key = ledgerKey(where);
        const row = ledger.has(key)
          ? { ...ledger.get(key), ...update }
          : { ...create, id: key, pageOperationKey: null };
        ledger.set(key, row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = [...ledger.values()].filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
  };
  const runs: Row[] = [];
  const tasks: Row[] = [];
  const live = { thread: true, member: true, bot: true, threadGeneration: 0 };
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 0, 1) + ++clock);
  const purchase = {
    findUnique: async ({ where }: { where: Row }) =>
      purchases.find((row) => matches(row, where)) ?? null,
    findUniqueOrThrow: async ({ where }: { where: Row }) => {
      const row = purchases.find((row) => matches(row, where));
      if (!row) throw new Error("Unknown fixture purchase");
      return row;
    },
    findFirst: async ({ where }: { where: Row }) =>
      purchases.find((row) => matches(row, where)) ?? null,
    findMany: async ({ where, select }: { where: Row; select?: Record<string, boolean> }) =>
      purchases
        .filter((row) => matches(row, where))
        .map((row) =>
          Object.fromEntries(
            Object.keys(select ?? { id: true }).map((key) => [key, row[key as keyof Purchase]]),
          ),
        ),
    upsert: async ({ where, create }: { where: Row; create: Row }) => {
      const existing = purchases.find((row) => matches(row, where));
      if (existing) return existing;
      const row = {
        id: `purchase-${purchases.length + 1}`,
        approvalUrl: null,
        nextPollAt: null,
        wokenStatus: null,
        cardCiphertext: null,
        tokenCiphertext: null,
        merchantAccountId: null,
        paymentChallenge: null,
        requestCiphertext: null,
        credentialType: "card",
        createdAt: new Date(),
        ...create,
        updatedAt: stamp(),
      } as Purchase;
      purchases.push(row);
      return row;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const found = purchases.filter((row) => matches(row, where));
      for (const row of found) Object.assign(row, data, { updatedAt: stamp() });
      return { count: found.length };
    },
  };
  const tx = {
    ...spending,
    purchase,
    thread: {
      updateMany: async ({ where }: { where: Row }) => ({
        count:
          live.thread &&
          where.id === fixture.threadId &&
          where.historyCompactionGeneration === live.threadGeneration
            ? 1
            : 0,
      }),
      findUniqueOrThrow: async () => ({ historyCompactionGeneration: live.threadGeneration }),
    },
    spaceMember: { findUnique: async () => (live.member ? { id: "member" } : null) },
    bot: { findFirst: async () => (live.bot ? { id: fixture.botId } : null) },
    task: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: `task-${tasks.length + 1}`, ...data };
        tasks.push(row);
        return row;
      },
    },
    run: {
      findFirst: async ({ where }: { where: Row }) =>
        runs.find((row) => matches(row, where)) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row = { id: `run-${runs.length + 1}`, ...data };
        runs.push(row);
        return row;
      },
    },
  };
  const prisma = {
    ...tx,
    $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as PrismaClient;
  return { prisma, purchases, runs, tasks, live, limits, ledger };
}

export function fakeJobs() {
  const enqueued: BackgroundJob[] = [];
  const jobs: JobPublisher = {
    enqueue: async (job) => {
      enqueued.push(job);
    },
    cancel: async () => {},
    close: async () => {},
  };
  return { enqueued, jobs };
}
