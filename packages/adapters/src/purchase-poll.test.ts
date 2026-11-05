// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited tests remain Apache-2.0; settlement polling coverage is PolyForm-covered.

import { PaymentWalletRequestRejected } from "@orkbot/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakePaymentWallet, fakeJobs, fakePurchasePrisma } from "./fake-purchases.js";
import { PURCHASE_POLL_DEADLINE_MS, pollPurchase, reconcilePurchases } from "./purchase-poll.js";
import { executePurchaseTool } from "./purchase-service.js";

vi.mock("./payment-wallets.js", () => ({
  withPaymentWalletCredential: async (
    _deps: unknown,
    _actor: unknown,
    fn: (credential: { secret: string; refreshAt: null }) => Promise<unknown>,
  ) => fn({ secret: "credential", refreshAt: null }),
}));

const fixture = { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" };

async function setup() {
  const db = fakePurchasePrisma(fixture);
  const queue = fakeJobs();
  const wallet = new FakePaymentWallet();
  const deps = {
    prisma: db.prisma,
    secretStore: {} as never,
    jobs: queue.jobs,
    paymentWallet: wallet,
  };
  await executePurchaseTool(
    deps,
    {
      operationId: "op-1",
      traceId: "op-1",
      spaceId: fixture.spaceId,
      userId: fixture.userId,
      botId: fixture.botId,
      signal: new AbortController().signal,
    },
    { threadId: fixture.threadId },
    "request_purchase",
    {
      merchantName: "Example Store",
      merchantUrl: "https://shop.example.test/checkout",
      amount: 1999,
      currency: "usd",
      reason: "Two boxes of printer paper for the office, as the user asked this morning. ".repeat(
        2,
      ),
    },
  );
  queue.enqueued.length = 0;
  const approve = () =>
    wallet.snapshots.set("remote-op-1", { id: "remote-op-1", status: "approved" });
  const poll = () => pollPurchase(deps, { purchaseId: "purchase-1" });
  return { ...db, ...queue, wallet, deps, approve, poll, row: () => db.purchases[0]! };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pollPurchase", () => {
  it("keeps polling while the owner has not decided", async () => {
    const env = await setup();
    await env.poll();
    expect(env.row()).toMatchObject({ status: "pending_approval" });
    expect(env.row().nextPollAt).toBeInstanceOf(Date);
    expect(env.runs).toHaveLength(0);
    expect(env.enqueued.map((job) => job.name)).toEqual(["purchase.poll"]);
  });

  it("wakes the bot once with a fixed prompt when the owner decides", async () => {
    const env = await setup();
    env.approve();
    await env.poll();
    expect(env.row()).toMatchObject({
      status: "approved",
      nextPollAt: expect.any(Date),
      wokenStatus: "approved",
    });
    expect(env.tasks).toEqual([
      expect.objectContaining({
        prompt: "Purchase purchase-1 is approved. Use purchase_status to continue.",
        threadId: fixture.threadId,
      }),
    ]);
    expect(env.runs).toEqual([
      expect.objectContaining({
        trigger: "purchase",
        status: "queued",
        clientNonce: "purchase-wake:purchase-1:approved",
      }),
    ]);
    expect(env.enqueued).toEqual([
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-1" } }),
      expect.objectContaining({ name: "purchase.poll" }),
    ]);
    // A later status poll keeps the reservation without waking the bot twice.
    await env.poll();
    expect(env.runs).toHaveLength(1);
  });

  it("keeps settling a deleted bot's wallet without waking it", async () => {
    const env = await setup();
    env.live.bot = false;
    env.approve();
    await env.poll();
    expect(env.runs).toHaveLength(0);
    expect(env.row()).toMatchObject({ status: "approved", nextPollAt: expect.any(Date) });

    const pending = await setup();
    pending.live.thread = false;
    await pending.poll();
    expect(pending.row()).toMatchObject({
      status: "pending_approval",
      nextPollAt: expect.any(Date),
    });
  });

  it("keeps settling a cleared chat's wallet without waking it", async () => {
    const env = await setup();
    env.live.threadGeneration += 1;
    env.approve();
    await env.poll();
    expect(env.runs).toHaveLength(0);
    expect(env.row()).toMatchObject({ status: "approved", nextPollAt: expect.any(Date) });
  });

  it("expires a purchase nobody decided on after the deadline", async () => {
    const env = await setup();
    vi.useFakeTimers({ now: Date.now() + PURCHASE_POLL_DEADLINE_MS + 1 });
    await env.poll();
    expect(env.row()).toMatchObject({ status: "expired", nextPollAt: null });
    expect(env.runs).toEqual([
      expect.objectContaining({ clientNonce: "purchase-wake:purchase-1:expired" }),
    ]);
  });

  it("marks a purchase the wallet no longer knows as failed", async () => {
    const env = await setup();
    env.wallet.getError = new PaymentWalletRequestRejected("The purchase was not found.");
    await env.poll();
    expect(env.row()).toMatchObject({ status: "failed", nextPollAt: null });
  });

  it("retries later on a transient error", async () => {
    const env = await setup();
    env.wallet.getError = new Error("network");
    await env.poll();
    expect(env.row()).toMatchObject({ status: "pending_approval" });
    expect(env.row().nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 10_000);
    expect(env.enqueued.map((job) => job.name)).toEqual(["purchase.poll"]);
  });
});

describe("reconcilePurchases", () => {
  it("re-enqueues due polls for the configured wallet", async () => {
    const env = await setup();
    env.row().nextPollAt = new Date(Date.now() - 1);
    await reconcilePurchases(env.deps);
    expect(env.enqueued).toEqual([
      expect.objectContaining({ name: "purchase.poll", payload: { purchaseId: "purchase-1" } }),
    ]);
    env.enqueued.length = 0;
    await reconcilePurchases({ ...env.deps, paymentWallet: null });
    expect(env.enqueued).toHaveLength(0);
  });
});
