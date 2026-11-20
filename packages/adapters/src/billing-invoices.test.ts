// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { BillingCheckoutCompletedError, BillingNoMonthlyCreditsError } from "@orkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { BillingEmulator } from "./billing-emulator.js";
import { StripeBillingProvider } from "./stripe-billing.js";
import { StripeEmulator } from "./testing/stripe-emulator.js";

const urls = { successUrl: "https://example.com/ok", cancelUrl: "https://example.com/no" };
const owner = { email: "owner@example.com", organizationId: "org_1" };
const NOW = Date.UTC(2026, 10, 20);

function setupStripe(now: () => number) {
  const wire = new StripeEmulator({ now });
  const provider = new StripeBillingProvider({
    secretKey: wire.secretKey,
    webhookSecret: "whsec_fake",
    priceId: wire.priceId,
    fetch: wire.fetch,
    now,
  });
  return { wire, provider };
}

for (const name of ["emulator", "stripe"] as const) {
  describe(`${name} paid subscription invoice evidence`, () => {
    for (const payment of ["card", "balance"] as const) {
      it(`records first payment only after a declined invoice settles with ${payment}`, async () => {
        let clock = NOW;
        const { provider, control } =
          name === "stripe"
            ? (() => {
                const { provider, wire } = setupStripe(() => clock);
                return { provider, control: wire };
              })()
            : (() => {
                const provider = new BillingEmulator({ now: () => clock });
                return { provider, control: provider };
              })();
        const { customerId } = await provider.createCustomer(owner);
        await provider.createCheckout({ customerId, seats: 1, trialDays: 14, ...urls });
        control.completeCheckout(customerId);
        expect(await provider.getFirstPaidSubscriptionInvoiceAt(customerId)).toBeNull();
        clock += 14 * 86400000;
        const invoiceId = control.failSubscriptionPayment(customerId);
        expect((await provider.getCustomerSubscription(customerId))?.status).toBe("past_due");
        expect(await provider.getFirstPaidSubscriptionInvoiceAt(customerId)).toBeNull();
        await expect(
          provider.createCheckout({ customerId, seats: 1, ...urls }),
        ).rejects.toBeInstanceOf(BillingCheckoutCompletedError);
        if (payment === "balance")
          await provider.grantBalanceCredit(customerId, 1500, "test_balance");
        clock += 86400000;
        control.settleSubscriptionInvoice(customerId, invoiceId, payment);
        const firstPaidAt = new Date(clock);
        expect((await provider.getCustomerSubscription(customerId))?.status).toBe("active");
        expect(await provider.getFirstPaidSubscriptionInvoiceAt(customerId)).toEqual(firstPaidAt);
        clock += 86400000;
        control.settleSubscriptionInvoice(customerId, invoiceId, payment);
        control.invoiceSubscription(customerId);
        expect(await provider.getFirstPaidSubscriptionInvoiceAt(customerId)).toEqual(firstPaidAt);
      });
    }
  });
}

describe("Stripe invoice history", () => {
  it("paginates, scopes to customer and subscription, rejects free/carried/unfinished invoices, and orders by paid_at", async () => {
    const { wire, provider } = setupStripe(() => NOW);
    wire.pageSize = 1;
    const { customerId } = await provider.createCustomer(owner);
    await provider.createCheckout({ customerId, seats: 1, trialDays: 14, ...urls });
    wire.completeCheckout(customerId);
    const template = wire.invoices[0]!;
    const paid = {
      ...template,
      total: 1000,
      amount_paid: 1000,
      amount_due: 1000,
      status_transitions: { paid_at: NOW / 1000 + 100 },
    };
    wire.invoices.push(
      { ...paid, id: "in_actual", status_transitions: { paid_at: NOW / 1000 + 200 } },
      { ...paid, id: "in_legacy", parent: null, subscription: "sub_old" },
      { ...paid, id: "in_topup", parent: null, status_transitions: { paid_at: NOW / 1000 - 10 } },
      {
        ...paid,
        id: "in_other_customer",
        customer: "cus_other",
        status_transitions: { paid_at: 1 },
      },
      { ...paid, id: "in_free", total: 0, status_transitions: { paid_at: 2 } },
      {
        ...paid,
        id: "in_carried",
        amount_paid: 0,
        amount_due: 0,
        starting_balance: 0,
        ending_balance: 1000,
        status_transitions: { paid_at: 3 },
      },
      { ...paid, id: "in_unfinished", status_transitions: { paid_at: null } },
    );
    expect(await provider.getFirstPaidSubscriptionInvoiceAt(customerId)).toEqual(
      new Date((NOW / 1000 + 100) * 1000),
    );
    expect(
      wire.requests.filter((request) => request.path === "/v1/invoices").length,
    ).toBeGreaterThan(1);
  });
});

describe("BillingEmulator checkout and plan guards", () => {
  for (const status of ["past_due", "unpaid", "incomplete", "paused"] as const) {
    it(`blocks checkout and credit plan changes while ${status}`, async () => {
      const provider = new BillingEmulator({ modelCredits: true, now: () => NOW });
      const { customerId } = await provider.createCustomer(owner);
      await provider.createCreditCheckout({
        customerId,
        amountCents: 1000,
        monthly: true,
        ...urls,
      });
      provider.completeCreditCheckout(customerId);
      provider.setStatus(customerId, status);
      await expect(provider.setMonthlyCredits(customerId, 2000)).rejects.toBeInstanceOf(
        BillingNoMonthlyCreditsError,
      );
      await expect(
        provider.createCreditCheckout({ customerId, amountCents: 2000, monthly: true, ...urls }),
      ).rejects.toBeInstanceOf(BillingCheckoutCompletedError);
      await expect(
        provider.createByokCheckout({ customerId, amountCents: 1500, ...urls }),
      ).rejects.toBeInstanceOf(BillingCheckoutCompletedError);
    });
    it(`blocks monthly credit checkout for ${status} own-key subscription`, async () => {
      const provider = new BillingEmulator({ now: () => NOW });
      const { customerId } = await provider.createCustomer(owner);
      await provider.createByokCheckout({ customerId, amountCents: 1500, ...urls });
      provider.completeByokCheckout(customerId);
      provider.setStatus(customerId, status);
      await expect(
        provider.createCreditCheckout({ customerId, amountCents: 1000, monthly: true, ...urls }),
      ).rejects.toBeInstanceOf(BillingCheckoutCompletedError);
    });
  }
  it("preserves an active own-key plan switch to monthly credits", async () => {
    const provider = new BillingEmulator({ now: () => NOW });
    const { customerId } = await provider.createCustomer(owner);
    await provider.createByokCheckout({ customerId, amountCents: 1500, ...urls });
    provider.completeByokCheckout(customerId);
    await expect(
      provider.createCreditCheckout({ customerId, amountCents: 1000, monthly: true, ...urls }),
    ).resolves.toHaveProperty("url");
  });
});

describe("Stripe checkout and credit plan guards", () => {
  for (const status of ["past_due", "unpaid", "incomplete", "paused"] as const) {
    it(`blocks failed BYOK checkout replacement while ${status}`, async () => {
      const { wire, provider } = setupStripe(() => NOW);
      const { customerId } = await provider.createCustomer(owner);
      await provider.createCheckout({ customerId, seats: 1, ...urls });
      wire.completeCheckout(customerId, status);
      Object.assign(wire.subscriptions[0]!, { metadata: { orkbot_plan: "byok" } });
      await expect(
        provider.createCreditCheckout({ customerId, amountCents: 2000, monthly: true, ...urls }),
      ).rejects.toBeInstanceOf(BillingCheckoutCompletedError);
      expect(wire.sessions).toHaveLength(1);
    });
    it(`refuses a credit plan change while ${status}`, async () => {
      const { wire, provider } = setupStripe(() => NOW);
      const { customerId } = await provider.createCustomer(owner);
      await provider.createCheckout({ customerId, seats: 1, ...urls });
      wire.completeCheckout(customerId, status);
      Object.assign(wire.subscriptions[0]!, { metadata: { orkbot_credit_cents: "1000" } });
      await expect(provider.setMonthlyCredits(customerId, 2000)).rejects.toBeInstanceOf(
        BillingNoMonthlyCreditsError,
      );
      expect(
        wire.requests.some(
          (request) => request.method === "POST" && request.path.startsWith("/v1/subscriptions/"),
        ),
      ).toBe(false);
    });
  }
  it("permits an active BYOK plan to switch to monthly credits", async () => {
    const { wire, provider } = setupStripe(() => NOW);
    const { customerId } = await provider.createCustomer(owner);
    await provider.createCheckout({ customerId, seats: 1, ...urls });
    wire.completeCheckout(customerId);
    Object.assign(wire.subscriptions[0]!, { metadata: { orkbot_plan: "byok" } });
    const fetchImpl: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/v1/prices")
        return Response.json({
          data: [
            {
              id: "price_credits",
              unit_amount: 2000,
              currency: "usd",
              recurring: { interval: "month", interval_count: 1 },
              product: { active: true },
            },
          ],
          has_more: false,
        });
      return wire.fetch(input, init);
    };
    const creditProvider = new StripeBillingProvider({
      secretKey: wire.secretKey,
      webhookSecret: "whsec_fake",
      fetch: fetchImpl,
    });
    await expect(
      creditProvider.createCreditCheckout({
        customerId,
        amountCents: 2000,
        monthly: true,
        ...urls,
      }),
    ).resolves.toHaveProperty("url");
  });
});
