// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AdapterContext, BrowserActResult, ComputerRef } from "@orkbot/adapter-kit";
import type * as DatabaseModule from "@orkbot/db";
import {
  readSpendingLimit,
  recordSecurityEvent,
  reserveSpending,
  setSpendingLimit,
} from "@orkbot/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserActFromTool } from "./browser-tools.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { fakePurchasePrisma } from "./fake-purchases.js";
import type { PagePayment } from "./purchase-budget.js";
import {
  checkPagePayment,
  pagePurchaseMoney,
  reservePagePayment,
  walletSpendingKey,
} from "./purchase-budget.js";
import type { PurchaseApproval } from "./purchase-gate.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";
import { prepareToolRequest } from "./run-tool-request.js";

vi.mock("@orkbot/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseModule>()),
  recordSecurityEvent: vi.fn(async () => undefined),
}));

const fixture = { userId: "user", spaceId: "space", botId: "bot", threadId: "thread" };
const computer: ComputerRef = {
  id: "computer",
  botId: fixture.botId,
  kind: "fake",
  providerRef: "computer",
};

function setup(amount = "25,00 PLN") {
  const db = fakePurchasePrisma(fixture);
  const purchase: PurchaseApproval = {
    steps: [0],
    site: "shop.example.test",
    label: "Pay now",
    amount,
    amountSource: "page",
  };
  const browser = Object.assign(new FakeBrowserProvider(), {
    purchaseCheck: vi.fn(async () => ({ purchase })),
  });
  const act = vi.spyOn(browser, "act").mockResolvedValue({
    ok: true,
    completed: 1,
    uncertain: false,
    url: "https://shop.example.test/checkout",
    title: "Checkout",
  });
  const context: AdapterContext = {
    operationId: "payment",
    traceId: "payment",
    ...fixture,
    signal: new AbortController().signal,
  };
  const ctx = {
    deps: { prisma: db.prisma },
    run: fixture,
    bot: { id: fixture.botId },
    context,
    providers: { browser },
    state: { walletHosts: new Set<string>(), walletPurchases: new Map<string, string>() },
    secrets: [],
    computer: { pageBrowserAllowed: true, heldForTakeover: false, get: async () => computer },
  } as unknown as RunContext;
  const payment: PagePayment = { purchase };
  const call = (effectKey = "page-payment") => ({ effectKey, pagePayment: payment }) as ToolCall;
  const limit = (value = 100) =>
    setSpendingLimit(db.prisma, fixture.userId, {
      amount: value,
      currency: "PLN",
      period: "monthly",
    });
  return { ...db, purchase, payment, ctx, context, browser, act, call, limit };
}

function request(): ToolRequest {
  return {
    name: "browser_act",
    args: { actions: [{ kind: "click", ref: "pay" }] },
  } as unknown as ToolRequest;
}

async function approvedWallet(env: ReturnType<typeof setup>) {
  const purchase = await env.prisma.purchase.upsert({
    where: { operationKey: "wallet-request" },
    update: {},
    create: {
      ...fixture,
      operationKey: "wallet-request",
      threadGeneration: 0,
      provider: "fake",
      remoteId: "remote-wallet-request",
      merchantName: "Example Shop",
      merchantUrl: "https://shop.example.test/checkout",
      amount: 2_599,
      currency: "pln",
      status: "approved",
    },
  });
  const operationKey = walletSpendingKey(purchase);
  expect(
    await reserveSpending(env.prisma, {
      userId: fixture.userId,
      operationKey,
      amount: 25.99,
      currency: "PLN",
    }),
  ).toEqual({ allowed: true });
  env.payment.walletPurchaseId = purchase.id;
  return purchase;
}

beforeEach(() => vi.clearAllMocks());

describe("page payment amounts", () => {
  it.each([
    ["1 234,56 zł", 1_234.56, "PLN"],
    ["1\u00a0234,56 PLN", 1_234.56, "PLN"],
    ["PLN 1.234,56", 1_234.56, "PLN"],
    ["USD 1,234.56", 1_234.56, "USD"],
    ["US$ 12.50", 12.5, "USD"],
    ["€12,50", 12.5, "EUR"],
    ["GBP 8", 8, "GBP"],
    ["₪4.95", 4.95, "ILS"],
    ["USD 0", 0, "USD"],
  ])("reads an unambiguous displayed amount %s", (text, amount, currency) => {
    expect(pagePurchaseMoney(String(text))).toEqual({ amount, currency });
  });

  it.each([
    "PLN 1,234",
    "PLN 1.234",
    "PLN -5",
    "NaN USD",
    "Infinity USD",
    "10 JPY",
    "10 USD + 10 EUR",
    "10.001 PLN",
    "$1e3",
    "$25",
    "Total USD 5",
    "5",
    "",
    "USD 1,,00",
    "USD 1.000.000",
    "USD 1000000000000",
  ])("refuses an unreadable or ambiguous amount %s", (text) => {
    expect(pagePurchaseMoney(text)).toEqual({ amount: null, currency: null });
  });
});

describe("budget checks before approval cards", () => {
  it.each([
    ["25 PLN", "limit"],
    ["10 EUR", "currency"],
    ["Total unavailable", "unreadable"],
    ["$10", "unreadable"],
  ])("blocks %s before preparing an approval card", async (amount, reason) => {
    const env = setup(amount);
    await env.limit(20);
    const pending = request();
    expect(await prepareToolRequest(env.ctx, pending)).toEqual({ error: expect.any(String) });
    expect(pending.purchase).toBeUndefined();
    expect(pending.fleetSummary).toBeUndefined();
    expect(env.ledger.size).toBe(0);
    expect(env.act).not.toHaveBeenCalled();
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "spending.limit.blocked",
        userId: fixture.userId,
        spaceId: fixture.spaceId,
        metadata: { kind: "spending_limit", reason },
      }),
    );
  });

  it.each(["Total unavailable", "$25"])(
    "keeps the approval flow without a limit for %s",
    async (amount) => {
      const env = setup(amount);
      const pending = request();
      expect(await prepareToolRequest(env.ctx, pending)).toBeUndefined();
      expect(pending.purchase).toEqual(env.purchase);
      expect(pending.fleetSummary).toBeDefined();
      expect(recordSecurityEvent).not.toHaveBeenCalled();
    },
  );

  it("includes other outstanding purchases in this account's limit", async () => {
    const env = setup("60 PLN");
    await env.limit();
    await reserveSpending(env.prisma, {
      userId: fixture.userId,
      operationKey: "other-space:other-bot",
      amount: 50,
      currency: "PLN",
    });
    expect(await checkPagePayment(env.ctx, env.payment)).toEqual({ error: expect.any(String) });
  });

  it("rejects several payment clicks whose total cannot be established", async () => {
    const env = setup();
    await env.limit();
    env.purchase.steps = [0, 1];
    expect(await checkPagePayment(env.ctx, env.payment)).toEqual({ error: expect.any(String) });
  });
});

describe("final page payment reservation", () => {
  it("does not count a plain page effect's own reservation again on retry", async () => {
    const env = setup("25 PLN");
    await env.limit(25);
    const first = await reservePagePayment(env.ctx, env.call("same-page-effect"));
    if ("error" in first) throw new Error(first.error);
    expect(await checkPagePayment(env.ctx, env.payment, "page:same-page-effect")).toBeUndefined();
    const retry = await reservePagePayment(env.ctx, env.call("same-page-effect"));
    expect(retry).not.toHaveProperty("error");
    expect(env.ledger.size).toBe(1);
    expect((await readSpendingLimit(env.prisma, fixture.userId)).spent).toBe(25);
  });

  it("rechecks a lower limit after the approval check", async () => {
    const env = setup("60 PLN");
    await env.limit();
    expect(await checkPagePayment(env.ctx, env.payment)).toBeUndefined();
    await env.limit(50);
    expect(await reservePagePayment(env.ctx, env.call())).toEqual({ error: expect.any(String) });
    expect(env.ledger.size).toBe(0);
  });

  it("rechecks account spending that arrived while the user approved", async () => {
    const env = setup("60 PLN");
    await env.limit();
    expect(await checkPagePayment(env.ctx, env.payment)).toBeUndefined();
    await reserveSpending(env.prisma, {
      userId: fixture.userId,
      operationKey: "another-approved-payment",
      amount: 50,
      currency: "PLN",
    });
    expect(await reservePagePayment(env.ctx, env.call())).toEqual({ error: expect.any(String) });
    expect(env.ledger.size).toBe(1);
  });

  it("rejects an unreadable page when the limit was enabled after approval", async () => {
    const env = setup("Total unavailable");
    expect(await checkPagePayment(env.ctx, env.payment)).toBeUndefined();
    await env.limit();
    expect(await reservePagePayment(env.ctx, env.call())).toEqual({ error: expect.any(String) });
    expect(env.ledger.size).toBe(0);
  });

  it("rechecks the account currency after the approval check", async () => {
    const env = setup();
    await env.limit();
    expect(await checkPagePayment(env.ctx, env.payment)).toBeUndefined();
    await setSpendingLimit(env.prisma, fixture.userId, {
      amount: 100,
      currency: "EUR",
      period: "monthly",
    });
    expect(await reservePagePayment(env.ctx, env.call())).toEqual({ error: expect.any(String) });
    expect(env.ledger.size).toBe(0);
  });

  it("runs the final check after resolving fills and prevents browser actions", async () => {
    const env = setup("60 PLN");
    await env.limit();
    expect(await checkPagePayment(env.ctx, env.payment)).toBeUndefined();
    env.purchase.steps = [1];
    const result = await browserActFromTool(
      env.browser,
      computer,
      env.context,
      {
        actions: [
          { kind: "fill_secret", ref: "name", secret: "login", field: "username" },
          { kind: "click", ref: "pay" },
        ],
      },
      {
        approvedPurchase: env.purchase,
        resolveSecretFill: async () => {
          await env.limit(50);
          return { text: "example", origin: "https://shop.example.test", hidden: false };
        },
        beforeAct: () => reservePagePayment(env.ctx, env.call()),
      },
    );
    expect(result).toMatchObject({ ok: false, completed: 0, uncertain: false });
    expect(env.act).not.toHaveBeenCalled();
    expect(env.ledger.size).toBe(0);
  });

  it("rejects a desktop payment when the page total changed after approval", async () => {
    const env = setup("25 PLN");
    await env.limit();
    env.payment.purchase = { ...env.purchase, amount: "24 PLN" };
    expect(await checkPagePayment(env.ctx, env.payment)).toBeUndefined();
    const call = {
      ...env.call(),
      name: "computer_act",
      args: { actions: [{ kind: "click", x: 10, y: 20 }] },
    } as ToolCall;
    expect(await reservePagePayment(env.ctx, call)).toEqual({ error: expect.any(String) });
    expect(env.ledger.size).toBe(0);
  });

  it.each([
    [{ completed: 0, uncertain: false }, "released", 0],
    [{ completed: 0, uncertain: true }, "confirmed", 25],
    [{ completed: 0 }, "confirmed", 25],
    [{ completed: 1, uncertain: false }, "confirmed", 25],
  ])("settles a page outcome %j conservatively", async (result, status, spent) => {
    const env = setup();
    await env.limit();
    const reserved = await reservePagePayment(env.ctx, env.call());
    if ("error" in reserved) throw new Error(reserved.error);
    expect([...env.ledger.values()][0]?.status).toBe("reserved");
    await reserved.settle?.(result as Pick<BrowserActResult, "completed" | "uncertain">);
    expect([...env.ledger.values()][0]?.status).toBe(status);
    expect((await readSpendingLimit(env.prisma, fixture.userId)).spent).toBe(spent);
  });

  it("releases a payment when the browser completed only the earlier nonpayment actions", async () => {
    const env = setup();
    env.purchase.steps = [1];
    await env.limit();
    const reserved = await reservePagePayment(env.ctx, env.call());
    if ("error" in reserved) throw new Error(reserved.error);
    await reserved.settle?.({ completed: 1, uncertain: false });
    expect((await readSpendingLimit(env.prisma, fixture.userId)).spent).toBe(0);
  });
});

describe("wallet-backed page payments", () => {
  it("carries the server's wallet identity from the fill into the prepared payment", async () => {
    const env = setup("25 PLN");
    await env.limit(25.99);
    const wallet = await approvedWallet(env);
    env.ctx.state.walletHosts.add(env.purchase.site);
    env.ctx.state.walletPurchases!.set(env.purchase.site, wallet.id);
    const pending = request();
    expect(await prepareToolRequest(env.ctx, pending)).toBeUndefined();
    expect(pending.pagePayment).toEqual({ purchase: env.purchase, walletPurchaseId: wallet.id });
    expect(pending.fleetSummary).toBeUndefined();
    expect(pending.purchase).toBeUndefined();
    expect(env.ledger.size).toBe(1);
  });

  it("uses the exact wallet amount in major units without counting the click twice", async () => {
    const env = setup("25.00 PLN");
    await env.limit(25.99);
    const wallet = await approvedWallet(env);
    expect(await checkPagePayment(env.ctx, env.payment)).toBeUndefined();
    const reserved = await reservePagePayment(env.ctx, env.call());
    if ("error" in reserved) throw new Error(reserved.error);
    await reserved.settle?.({ completed: 1, uncertain: false });
    expect(env.ledger.size).toBe(1);
    const [entry] = [...env.ledger.values()];
    expect(entry?.operationKey).toBe(walletSpendingKey(wallet));
    expect(String(entry?.amount)).toBe("25.99");
    expect(entry?.status).toBe("reserved");
    expect((await readSpendingLimit(env.prisma, fixture.userId)).spent).toBe(25.99);
  });

  it("keeps one wallet reservation when the same checkout effect is retried", async () => {
    const env = setup("25 PLN");
    await env.limit(25.99);
    await approvedWallet(env);
    const first = await reservePagePayment(env.ctx, env.call("first-checkout"));
    if ("error" in first) throw new Error(first.error);
    await first.settle?.({ completed: 1, uncertain: false });
    expect([...env.ledger.values()][0]?.pageOperationKey).toBe("page:first-checkout");
    expect(await checkPagePayment(env.ctx, env.payment, "page:first-checkout")).toBeUndefined();
    const retry = await reservePagePayment(env.ctx, env.call("first-checkout"));
    if ("error" in retry) throw new Error(retry.error);
    await retry.settle?.({ completed: 1, uncertain: false });
    expect(env.ledger.size).toBe(1);
    expect((await readSpendingLimit(env.prisma, fixture.userId)).spent).toBe(25.99);
  });

  it("counts a distinct later checkout separately from the wallet reservation", async () => {
    const env = setup("25 PLN");
    await env.limit(60);
    await approvedWallet(env);
    const first = await reservePagePayment(env.ctx, env.call("first-checkout"));
    if ("error" in first) throw new Error(first.error);
    await first.settle?.({ completed: 1, uncertain: false });
    const later = await reservePagePayment(env.ctx, env.call("later-checkout"));
    if ("error" in later) throw new Error(later.error);
    await later.settle?.({ completed: 1, uncertain: false });
    expect(env.ledger.size).toBe(2);
    expect([...env.ledger.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationKey: "wallet:wallet-request",
          pageOperationKey: "page:first-checkout",
          status: "reserved",
        }),
        expect.objectContaining({ operationKey: "page:later-checkout", status: "confirmed" }),
      ]),
    );
    expect((await readSpendingLimit(env.prisma, fixture.userId)).spent).toBe(50.99);
  });

  it("blocks a distinct checkout that would exceed the limit instead of reusing wallet funds", async () => {
    const env = setup("25 PLN");
    await env.limit(25.99);
    await approvedWallet(env);
    const first = await reservePagePayment(env.ctx, env.call("first-checkout"));
    if ("error" in first) throw new Error(first.error);
    await first.settle?.({ completed: 1, uncertain: false });
    expect(await checkPagePayment(env.ctx, env.payment)).toEqual({ error: expect.any(String) });
    expect(await reservePagePayment(env.ctx, env.call("later-checkout"))).toEqual({
      error: expect.any(String),
    });
    expect(env.ledger.size).toBe(1);
    expect((await readSpendingLimit(env.prisma, fixture.userId)).spent).toBe(25.99);
  });

  it("clears a definitely refused wallet checkout binding for a new attempt", async () => {
    const env = setup("25 PLN");
    await env.limit(25.99);
    await approvedWallet(env);
    const first = await reservePagePayment(env.ctx, env.call("refused-checkout"));
    if ("error" in first) throw new Error(first.error);
    expect([...env.ledger.values()][0]?.pageOperationKey).toBe("page:refused-checkout");
    await first.settle?.({ completed: 0, uncertain: false });
    expect([...env.ledger.values()][0]).toMatchObject({
      status: "reserved",
      pageOperationKey: null,
    });
    const retry = await reservePagePayment(env.ctx, env.call("new-attempt"));
    if ("error" in retry) throw new Error(retry.error);
    expect([...env.ledger.values()][0]?.pageOperationKey).toBe("page:new-attempt");
    expect(env.ledger.size).toBe(1);
    expect((await readSpendingLimit(env.prisma, fixture.userId)).spent).toBe(25.99);
  });

  it("keeps an uncertain wallet checkout binding and blocks another attempt over the limit", async () => {
    const env = setup("25 PLN");
    await env.limit(25.99);
    await approvedWallet(env);
    const first = await reservePagePayment(env.ctx, env.call("uncertain-checkout"));
    if ("error" in first) throw new Error(first.error);
    await first.settle?.({ completed: 0, uncertain: true });
    expect([...env.ledger.values()][0]?.pageOperationKey).toBe("page:uncertain-checkout");
    expect(await reservePagePayment(env.ctx, env.call("new-attempt"))).toEqual({
      error: expect.any(String),
    });
    expect(env.ledger.size).toBe(1);
  });

  it("recovers the approved canonical wallet binding after restart and counts later checkouts separately", async () => {
    const env = setup("25 PLN");
    await env.limit(60);
    const wallet = await approvedWallet(env);
    wallet.cardCiphertext = "sealed-fixture";
    env.ctx.state.walletPurchases!.set(env.purchase.site, wallet.id);
    const initial = request();
    expect(await prepareToolRequest(env.ctx, initial)).toBeUndefined();
    expect(initial.args.walletPurchaseId).toBe(wallet.id);
    expect(initial.args.purchaseApproval).toEqual(env.purchase);
    expect(initial.effectRequest).toEqual(initial.args);
    const storedArgs = structuredClone(initial.args);
    env.ctx.state.walletHosts.clear();
    env.ctx.state.walletPurchases!.clear();
    const recovered: ToolRequest = {
      ...request(),
      args: storedArgs,
      nextApprovedTool: "browser_act",
      approvedEffectKey: "recovered-checkout",
    };
    expect(await prepareToolRequest(env.ctx, recovered)).toBeUndefined();
    expect(recovered.pagePayment?.walletPurchaseId).toBe(wallet.id);
    const first = await reservePagePayment(env.ctx, {
      ...env.call("recovered-checkout"),
      pagePayment: recovered.pagePayment,
    });
    if ("error" in first) throw new Error(first.error);
    await first.settle?.({ completed: 1, uncertain: false });
    expect(env.ledger.size).toBe(1);
    expect((await readSpendingLimit(env.prisma, fixture.userId)).spent).toBe(25.99);

    const later = request();
    expect(await prepareToolRequest(env.ctx, later)).toBeUndefined();
    const second = await reservePagePayment(env.ctx, {
      ...env.call("later-recovered-checkout"),
      pagePayment: later.pagePayment,
    });
    if ("error" in second) throw new Error(second.error);
    await second.settle?.({ completed: 1, uncertain: false });
    expect(env.ledger.size).toBe(2);
    expect((await readSpendingLimit(env.prisma, fixture.userId)).spent).toBe(50.99);
  });

  it.each([25.99, 60])("ignores a model-supplied wallet binding with limit %s", async (amount) => {
    const env = setup("25 PLN");
    await env.limit(amount);
    const wallet = await approvedWallet(env);
    wallet.cardCiphertext = "sealed-fixture";
    const spoofed: ToolRequest = {
      ...request(),
      args: {
        ...request().args,
        walletPurchaseId: wallet.id,
        purchaseApproval: env.purchase,
      },
    };
    const refusal = await prepareToolRequest(env.ctx, spoofed);
    expect(spoofed.pagePayment?.walletPurchaseId).toBeUndefined();
    if (amount === 25.99) {
      expect(refusal).toEqual({ error: expect.any(String) });
      expect(env.ledger.size).toBe(1);
    } else {
      expect(refusal).toBeUndefined();
      expect(spoofed.args).not.toHaveProperty("walletPurchaseId");
      const page = await reservePagePayment(env.ctx, {
        ...env.call("separate-checkout"),
        pagePayment: spoofed.pagePayment,
      });
      if ("error" in page) throw new Error(page.error);
      await page.settle?.({ completed: 1, uncertain: false });
      expect(env.ledger.size).toBe(2);
      expect((await readSpendingLimit(env.prisma, fixture.userId)).spent).toBe(50.99);
    }
    const walletEntry = [...env.ledger.values()].find(
      (entry) => entry.operationKey === walletSpendingKey(wallet),
    );
    expect(walletEntry?.pageOperationKey).toBeNull();
  });

  it("does not attribute a payment to a wallet card filled after the payment click", async () => {
    const env = setup("25 PLN");
    await env.limit(25.99);
    const wallet = await approvedWallet(env);
    wallet.cardCiphertext = "sealed-fixture";
    const pending: ToolRequest = {
      ...request(),
      args: {
        actions: [
          { kind: "click", ref: "pay" },
          { kind: "fill_card", ref: "card", field: "number", purchase: wallet.id },
        ],
      },
    };
    expect(await prepareToolRequest(env.ctx, pending)).toEqual({ error: expect.any(String) });
    expect(pending.pagePayment?.walletPurchaseId).toBeUndefined();
    expect(env.ledger.size).toBe(1);
    expect([...env.ledger.values()][0]?.pageOperationKey).toBeNull();
    expect(env.act).not.toHaveBeenCalled();
  });

  it.each(["Total unavailable", "26 PLN", "25.99 EUR"])(
    "rechecks the displayed amount %s even when wallet funds are already reserved",
    async (amount) => {
      const env = setup(amount);
      await approvedWallet(env);
      expect(await checkPagePayment(env.ctx, env.payment)).toBeUndefined();
      await env.limit();
      expect(await reservePagePayment(env.ctx, env.call())).toEqual({ error: expect.any(String) });
      expect(env.ledger.size).toBe(1);
    },
  );

  it.each(["bot", "user", "status", "origin"])(
    "refuses a wallet purchase with a changed %s",
    async (change) => {
      const env = setup("25 PLN");
      await env.limit();
      const wallet = await approvedWallet(env);
      if (change === "bot") wallet.botId = "another-bot";
      if (change === "user") wallet.userId = "another-user";
      if (change === "status") wallet.status = "denied";
      if (change === "origin") wallet.merchantUrl = "https://other.example.test/checkout";
      expect(await reservePagePayment(env.ctx, env.call())).toEqual({ error: expect.any(String) });
    },
  );
});
