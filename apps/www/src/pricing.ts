// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Modified by Ork contributors to document licensing scope. Existing material remains Apache-2.0.
import {
  BYOK_TIERS,
  MODEL_CREDIT_AMOUNTS,
  TRIAL_DAYS,
} from "@orkbot/contracts";
import { APP_URL, SELF_HOST_GUIDE_PATH } from "./site";
import { COMMERCIAL_DESCRIPTION, COMMERCIAL_STATUS } from "./licensing";

/** Whole dollars when the amount is round ("$15"), otherwise cents ("$12.50"). */
function dollars(cents: number) {
  const rounded = Math.round(cents);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: rounded % 100 === 0 ? 0 : 2,
  }).format(rounded / 100);
}

const STANDARD = BYOK_TIERS.standard;

export type PricingPlan = {
  name: string;
  price: string;
  note?: string;
  features: string[];
  action: { label: string; href: string };
};

const CREDITS_PRICE = `From ${dollars(MODEL_CREDIT_AMOUNTS[0])}/mo`;

/** Prices come from the same constants the app bills with. */
export const PRICING_PLANS: PricingPlan[] = [
  {
    name: "Self-hosted",
    price: "Free for noncommercial use",
    note: "Commercial use of new Ork work needs a paid license",
    features: [
      "Source-available: PolyForm NC + Apache baseline",
      "Your server or your own computer",
      "Bot computers in Docker or a sandbox",
      "Any model you connect",
    ],
    action: { label: "Self-hosting guide", href: SELF_HOST_GUIDE_PATH },
  },
  {
    name: "Your model",
    price:
      STANDARD.monthlyPriceCents === null ? "Free" : `${dollars(STANDARD.monthlyPriceCents)}/mo`,
    note:
      STANDARD.annualPriceCents === null
        ? undefined
        : `${dollars(STANDARD.annualPriceCents / 12)}/mo billed yearly`,
    features: [
      "Hosted by us",
      "Claude, ChatGPT, or any API key",
      "Cloud computer included",
      `${TRIAL_DAYS}-day free trial`,
    ],
    action: { label: "Start free trial", href: APP_URL },
  },
  {
    name: "Ork credits",
    price: CREDITS_PRICE,
    note: "Model usage included",
    features: [
      "Hosted by us",
      "No model account needed",
      "Cloud computer included",
      "Top up any time",
    ],
    action: { label: "Get started", href: APP_URL },
  },
];

function planMarkdown(plan: PricingPlan) {
  return `## ${plan.name}

${plan.price}${plan.note ? ` (${plan.note})` : ""}

${plan.features.map((feature) => `- ${feature}`).join("\n")}

[${plan.action.label}](${new URL(plan.action.href, "https://ork.run").href})`;
}

export const PRICING_MARKDOWN = `# Ork pricing

${PRICING_PLANS.slice(0, 1).map(planMarkdown).join("\n\n")}

## Commercial self-hosting

${COMMERCIAL_DESCRIPTION}

${COMMERCIAL_STATUS}

[Licensing and contact](https://ork.run/license/).

You pay the model, computer, and integration providers you choose to use.
`;
