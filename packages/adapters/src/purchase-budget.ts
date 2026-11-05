// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { MAX_SPENDING_AMOUNT } from "@orkbot/contracts";
import type { Purchase } from "@orkbot/db";
import {
  checkSpending,
  checkSpendingInTransaction,
  claimWalletPageInTransaction,
  confirmSpending,
  lockSpending,
  recordSecurityEvent,
  releaseSpending,
  reserveSpending,
  reserveSpendingInTransaction,
} from "@orkbot/db";
import type { PurchaseApproval } from "./purchase-gate.js";
import { detectPurchase } from "./purchase-gate.js";
import type { PurchaseDeps } from "./purchase-service.js";
import { findBotPurchase } from "./purchase-service.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";

type BudgetDeps = Pick<PurchaseDeps, "prisma">;
type Money = { amount: number | null; currency: string | null };
type Owner = { userId: string; spaceId: string };
export type PagePayment = { purchase: PurchaseApproval; walletPurchaseId?: string };
type ResolvedPayment = { money: Money; operationKey: string | undefined; wallet: boolean };

/** Resolve wallet identity on the server, never from a model-supplied exemption flag. */
export async function pagePaymentMoney(
  ctx: RunContext,
  payment: PagePayment,
  pageOperationKey?: string,
): Promise<{ error: string } | ResolvedPayment> {
  if (payment.walletPurchaseId) {
    const purchase = await findBotPurchase(ctx.deps, ctx.run, payment.walletPurchaseId);
    if (
      purchase?.status !== "approved" ||
      new URL(purchase.merchantUrl).host !== payment.purchase.site
    )
      return { error: "This wallet purchase is no longer approved for this checkout." };
    const operationKey = walletSpendingKey(purchase);
    const ledger = await ctx.deps.prisma.paymentLedgerEntry.findUnique({
      where: { userId_operationKey: { userId: ctx.run.userId, operationKey } },
    });
    if (ledger?.pageOperationKey == null || ledger.pageOperationKey === pageOperationKey)
      return { money: walletPurchaseMoney(purchase), operationKey, wallet: true };
  }
  const money = pagePurchaseMoney(payment.purchase.amount);
  // A batch with several payment clicks cannot establish a single charge amount safely.
  if (payment.purchase.steps.length > 1) money.amount = null;
  return { money, operationKey: undefined, wallet: false };
}

export async function checkPagePayment(
  ctx: RunContext,
  payment: PagePayment,
  pageOperationKey?: string,
): Promise<{ error: string } | undefined> {
  const resolved = await pagePaymentMoney(ctx, payment, pageOperationKey);
  if ("error" in resolved) return resolved;
  return checkPurchaseBudget(
    ctx.deps,
    ctx.run,
    validatedPageMoney(payment, resolved),
    resolved.operationKey ?? pageOperationKey,
  );
}

function validatedPageMoney(payment: PagePayment, resolved: ResolvedPayment): Money {
  const shown = pagePurchaseMoney(payment.purchase.amount);
  const unreadable =
    shown.amount === null || shown.currency === null || payment.purchase.steps.length > 1;
  const mismatchedWallet =
    resolved.wallet &&
    (shown.currency !== resolved.money.currency ||
      (shown.amount !== null &&
        resolved.money.amount !== null &&
        shown.amount > resolved.money.amount));
  return mismatchedWallet || unreadable ? { amount: null, currency: null } : resolved.money;
}

/** The browser invokes this after resolving all fills, immediately before executing actions. */
export async function reservePagePayment(
  ctx: RunContext,
  call: ToolCall,
): Promise<
  | { error: string }
  | { settle?: (result: { completed: number; uncertain?: boolean }) => Promise<void> }
> {
  const payment = call.pagePayment;
  if (!payment) return {};
  if (call.name === "computer_act") {
    const current = await detectPurchase(ctx, call.name, call.args);
    if (
      !current ||
      current.site !== payment.purchase.site ||
      current.label !== payment.purchase.label ||
      current.amount !== payment.purchase.amount
    )
      return { error: "The page changed since this payment was approved, so nothing was pressed." };
  }
  const pageKey = `page:${call.effectKey}`;
  const resolved = await pagePaymentMoney(ctx, payment, pageKey);
  if ("error" in resolved) return resolved;
  const key = resolved.operationKey ?? pageKey;
  const outcome = await ctx.deps.prisma.$transaction(async (tx) => {
    const checked = await checkSpendingInTransaction(tx, {
      userId: ctx.run.userId,
      ...validatedPageMoney(payment, resolved),
      operationKey: key,
    });
    if (!checked.allowed) return { decision: checked, key, wallet: resolved.wallet };
    const decision = await reserveSpendingInTransaction(tx, {
      userId: ctx.run.userId,
      operationKey: key,
      ...resolved.money,
    });
    if (!decision.allowed || !resolved.wallet) return { decision, key, wallet: resolved.wallet };
    if (await claimWalletPageInTransaction(tx, ctx.run.userId, key, pageKey))
      return { decision, key, wallet: true };
    // A distinct checkout already consumed this wallet association while this call waited.
    const money = validatedPageMoney(payment, {
      money: pagePurchaseMoney(payment.purchase.amount),
      wallet: false,
      operationKey: undefined,
    });
    return {
      decision: await reserveSpendingInTransaction(tx, {
        userId: ctx.run.userId,
        operationKey: pageKey,
        ...money,
      }),
      key: pageKey,
      wallet: false,
    };
  });
  const refused = await budgetRefusal(ctx.run, outcome.decision);
  if (refused) return refused;
  return {
    settle: async (result: { completed: number; uncertain?: boolean }) => {
      // The wallet's own outcome is authoritative. A refused page click leaves its card usable.
      if (!outcome.wallet)
        await settlePageSpending(ctx.deps, ctx.run, outcome.key, payment.purchase, result);
      else if (
        result.uncertain === false &&
        result.completed <=
          (payment.purchase.steps.length ? Math.min(...payment.purchase.steps) : 0)
      )
        await ctx.deps.prisma.$transaction(async (tx) => {
          await lockSpending(tx, ctx.run.userId);
          await tx.paymentLedgerEntry.updateMany({
            where: { userId: ctx.run.userId, operationKey: outcome.key, pageOperationKey: pageKey },
            data: { pageOperationKey: null },
          });
        });
    },
  };
}

/** Read a single displayed monetary value, refusing ambiguous separators or extra text. */
export function pagePurchaseMoney(text: string): Money {
  const unknown: Money = { amount: null, currency: null };
  const value = text.normalize("NFKC").trim();
  const tokens = "USD|EUR|GBP|ILS|PLN|US\\$|€|£|₪|zł";
  const prefix = new RegExp(`^(${tokens})\\s*([\\d., ]+)$`, "i").exec(value);
  const suffix = new RegExp(`^([\\d., ]+)\\s*(${tokens})$`, "i").exec(value);
  if (!prefix && !suffix) return unknown;
  const token = (prefix?.[1] ?? suffix?.[2])!.toUpperCase();
  const currency =
    ({ US$: "USD", "€": "EUR", "£": "GBP", "₪": "ILS", ZŁ: "PLN" } as Record<string, string>)[
      token
    ] ?? token;
  const raw = (prefix?.[2] ?? suffix?.[1])!.trim();
  // Thousands groups require all three digits. A lone 1,234 or 1.234 is ambiguous.
  let normalized: string;
  if (/^\d+(?:[.,]\d{1,2})?$/.test(raw)) normalized = raw.replace(",", ".");
  else if (/^\d{1,3}(?:,\d{3})+\.\d{1,2}$/.test(raw)) normalized = raw.replaceAll(",", "");
  else if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(raw))
    normalized = raw.replaceAll(".", "").replace(",", ".");
  else if (/^\d{1,3}(?: \d{3})+(?:[.,]\d{1,2})?$/.test(raw))
    normalized = raw.replaceAll(" ", "").replace(",", ".");
  else return unknown;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_SPENDING_AMOUNT) return unknown;
  return { amount, currency };
}

export const walletSpendingKey = (purchase: Pick<Purchase, "operationKey">) =>
  `wallet:${purchase.operationKey}`;

/** Wallet amounts use minor units; all supported limit currencies have two decimal places. */
export const walletPurchaseMoney = (purchase: Pick<Purchase, "amount" | "currency">): Money => ({
  amount: purchase.amount / 100,
  currency: purchase.currency.toUpperCase(),
});

export async function checkPurchaseBudget(
  deps: BudgetDeps,
  owner: Owner,
  money: Money,
  operationKey?: string,
) {
  return budgetRefusal(
    owner,
    await checkSpending(deps.prisma, { ...owner, ...money, operationKey }),
  );
}

export async function reservePurchaseBudget(
  deps: BudgetDeps,
  owner: Owner,
  operationKey: string,
  money: Money,
) {
  return budgetRefusal(
    owner,
    await reserveSpending(deps.prisma, { userId: owner.userId, operationKey, ...money }),
  );
}

export async function budgetRefusal(
  owner: Owner,
  decision: { allowed: true } | { allowed: false; reason: string },
): Promise<{ error: string } | undefined> {
  if (decision.allowed) return undefined;
  await recordSecurityEvent({
    type: "spending.limit.blocked",
    userId: owner.userId,
    spaceId: owner.spaceId,
    metadata: { kind: "spending_limit", reason: decision.reason },
  });
  return {
    error:
      decision.reason === "currency"
        ? "This payment is blocked because its currency differs from the account spending limit."
        : decision.reason === "unreadable"
          ? "This payment is blocked because its amount or currency cannot be read safely."
          : "This payment would exceed the account spending limit. Ask the user to review their limit in Settings.",
  };
}

/** Only a definite refusal releases funds. A lost response can follow a successful charge. */
export async function settlePageSpending(
  deps: BudgetDeps,
  owner: Owner,
  key: string,
  purchase: PurchaseApproval,
  result: { completed: number; uncertain?: boolean },
) {
  const firstPayment = purchase.steps.length ? Math.min(...purchase.steps) : 0;
  if (result.uncertain === false && result.completed <= firstPayment)
    await releaseSpending(deps.prisma, owner.userId, key);
  else await confirmSpending(deps.prisma, owner.userId, key);
}
