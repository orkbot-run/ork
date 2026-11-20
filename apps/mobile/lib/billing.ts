// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 material is preserved; billing recovery changes follow LICENSE.md.

import type { BillingStatus } from "@orkbot/contracts";
import {
  billingSubscriptionHoldsCheckout,
  billingSubscriptionNeedsRecovery,
  MOBILE_BILLING_CALLBACK_URL,
} from "@orkbot/contracts";
import { Linking } from "react-native";
import { rpc } from "./api";

export type Plan = "byok" | "credits";

/** An existing subscription requiring portal recovery rather than a new plan. */
export function billingNeedsRecovery(status: BillingStatus): boolean {
  return billingSubscriptionNeedsRecovery(status.state);
}

/** What the own-key plan's button does: a first trial, a paid checkout, or no payment at all. */
export function ownKeyOffer(status: BillingStatus): "trial" | "subscribe" | "free" {
  if (!status.byokPriceCents) return "free";
  return status.trialAvailable && !status.byokFreeUntil ? "trial" : "subscribe";
}

/** A plan that runs out on its own: a trial, a free period, or a canceled renewal. */
export function planEndsAt(status: BillingStatus): string | null {
  if (status.byokFreeUntil) return status.byokFreeUntil;
  if (status.state === "trialing") return status.trialEndsAt ?? null;
  return status.cancelAtPeriodEnd ? (status.currentPeriodEndsAt ?? null) : null;
}

/** The plan the organization pays with, once it has access. */
export function currentPlan(status: BillingStatus): Plan | null {
  if (!status.access) return null;
  return status.funding === "byok" ? "byok" : status.funding === "credits" ? "credits" : null;
}

/** The plan the organization is on, as shown when changing plans; a free period is no plan yet. */
export function subscribedPlan(status: BillingStatus): Plan | null {
  if (status.byokFreeUntil) return null;
  const plan = billingSubscriptionHoldsCheckout(status.state)
    ? status.funding
    : currentPlan(status);
  // Credits bought once, or left from a lapsed monthly plan, are a balance, not a plan to keep.
  if (plan === "credits")
    return status.monthlyAmountCents && billingSubscriptionHoldsCheckout(status.state)
      ? plan
      : null;
  return plan === "byok" ? plan : null;
}

/** What an own-key subscriber pays each month, which stays at the price they subscribed at. */
export function ownKeySubscriptionCents(status: BillingStatus): number | null {
  if (status.funding !== "byok" || !status.byokPriceCents || status.byokFreeUntil) return null;
  return !status.monthlyAmountCents && billingSubscriptionHoldsCheckout(status.state)
    ? status.byokPriceCents
    : null;
}

/**
 * Whether a checkout changed the plan. A canceled checkout returns to the same status, and
 * an organization that already had access (a free period, or changing plans) still has it.
 */
export function purchaseCompleted(before: BillingStatus, after: BillingStatus): boolean {
  if (!after.access) return false;
  return (
    !before.access ||
    after.state !== before.state ||
    after.funding !== before.funding ||
    after.monthlyAmountCents !== before.monthlyAmountCents ||
    after.byokFreeUntil !== before.byokFreeUntil
  );
}

let paywallShown = false;

/** The paywall holds the app until a plan is chosen; the inbox must not stack a second one. */
export function setPaywallShown(shown: boolean) {
  paywallShown = shown;
}

export function isPaywallShown() {
  return paywallShown;
}

/**
 * Opens a hosted checkout or billing portal in the in-app browser, which closes when the
 * provider returns to the app, then reads the result straight from the provider so the
 * app does not wait on the webhook.
 */
export async function openBillingPage(url: string): Promise<BillingStatus> {
  // Defer the native module so billing still opens (in Safari) on older binaries.
  const browser = await import("expo-web-browser").catch(() => null);
  // Ephemeral, so iOS opens checkout without asking to "sign in" with the payment site first.
  if (browser)
    await browser.openAuthSessionAsync(url, MOBILE_BILLING_CALLBACK_URL, {
      preferEphemeralSession: true,
    });
  else await Linking.openURL(url);
  return rpc("billing/refresh");
}
