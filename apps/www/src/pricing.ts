// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Modified by Ork contributors for prospective licensing. Existing material remains Apache-2.0.
import type { ByokTier, ComputerSize, SandboxKind } from "@orkbot/contracts";
import {
  BYOK_TIERS,
  byokTierPriceCents,
  COMPUTER_SIZE_SPECS,
  CREDITS_SANDBOX_ALLOWANCE_PERCENT,
  DEFAULT_MONTHLY_CREDIT_AMOUNT,
  MODEL_CREDIT_AMOUNTS,
  sandboxAllowanceHours,
  TRIAL_DAYS,
  TRIAL_SANDBOX_ALLOWANCE_CENTS,
} from "@orkbot/contracts";
import { APP_URL, SELF_HOST_GUIDE_PATH } from "./site";

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

/** Whole cloud computer hours an allowance in cents buys. */
function computerHours(cents: number) {
  return Math.floor(sandboxAllowanceHours(cents));
}

/** A computer size on two lines in the table; Markdown joins them. */
function computerSpecs(size: ComputerSize) {
  const specs = COMPUTER_SIZE_SPECS[size];
  return `${specs.vcpus} vCPU\n${specs.memoryGb} GB RAM`;
}

/** Computer hours a monthly credit plan of `cents` includes. */
function creditPlanHours(cents: number) {
  return computerHours((cents * CREDITS_SANDBOX_ALLOWANCE_PERCENT) / 100);
}

/** Display names for every sandbox a self-hosted deployment can use; typed so a new kind must be named. */
const SANDBOX_NAMES: Record<Exclude<SandboxKind, "none" | "desktop" | "fake">, string> = {
  docker: "Docker",
  kubernetes: "Kubernetes",
  incus: "Incus",
  boat: "Boat",
  boxd: "Boxd",
  createos: "CreateOS",
  daytona: "Daytona",
  e2b: "E2B",
  novita: "Novita",
  railway: "Railway",
  wuying: "Wuying",
};
const SANDBOX_PROVIDERS = Object.values(SANDBOX_NAMES);

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

/** A comparison cell: included, not included, or a short value with optional detail on hover. */
export type PricingCell = boolean | string | { label: string; detail: string };

const STANDARD_COMPUTER = computerSpecs(STANDARD.computerSize);

/** Own-model tiers on offer, from the terms the app bills with. */
const TIERS = (Object.keys(BYOK_TIERS) as ByokTier[]).flatMap((tier) => {
  const monthly = byokTierPriceCents(tier, "month");
  // A null Standard price makes the own-model plan free and hides the other tiers.
  if (monthly === null && tier !== "standard") return [];
  const terms = BYOK_TIERS[tier];
  return [
    {
      name: terms.name,
      price: monthly === null ? "Free" : `${dollars(monthly)}/mo`,
      computer: computerSpecs(terms.computerSize),
      hours: computerHours(terms.computerAllowanceCents),
    },
  ];
});

const COLUMN_COUNT = TIERS.length + 2;
const included = (cell: PricingCell): PricingCell[] => Array(COLUMN_COUNT).fill(cell);

export const PRICING_COMPARISON = {
  columns: [
    { name: "Self-hosted", price: "Free for noncommercial use" },
    ...TIERS.map((tier) => ({ name: tier.name, price: tier.price })),
    { name: "Ork credits", price: CREDITS_PRICE },
  ],
  /** Most important first: what sets Ork apart, then the limits. */
  rows: [
    {
      feature: "Any model",
      cells: [
        ...included(true).slice(1),
        { label: "Our catalog", detail: "Credits cover the models Ork offers" },
      ],
    },
    {
      feature: "Sandbox",
      cells: [
        {
          label: `Your computer or any of ${SANDBOX_PROVIDERS.length}`,
          detail: `Your own computer through the desktop app, or ${SANDBOX_PROVIDERS.join(", ")}`,
        },
        ...TIERS.map(() => "Included"),
        "Included",
      ],
    },
    {
      feature: "Model usage",
      cells: [
        "Unlimited",
        ...TIERS.map(() => "Unlimited"),
        { label: "Credits", detail: "Charged at the provider's price, with no markup" },
      ],
    },
    { feature: "Integrations and MCP", cells: included(true) },
    {
      feature: "Cloud computer hours",
      hint: "Counted only while a cloud computer runs.",
      cells: [
        "Unlimited",
        ...TIERS.map((tier) => `${tier.hours} hours/mo`),
        {
          label: `From ${creditPlanHours(MODEL_CREDIT_AMOUNTS[0])} hours/mo`,
          detail: `Grows with your plan: ${dollars(DEFAULT_MONTHLY_CREDIT_AMOUNT)} a month includes ${creditPlanHours(DEFAULT_MONTHLY_CREDIT_AMOUNT)} hours`,
        },
      ],
    },
    {
      feature: "Cloud computer",
      cells: ["Any size", ...TIERS.map((tier) => tier.computer), STANDARD_COMPUTER],
    },
    { feature: "Cloud computers in the EU", cells: ["Your choice", ...TIERS.map(() => true), true] },
    {
      feature: "Free trial",
      cells: [
        false,
        ...TIERS.map(() => ({
          label: `${TRIAL_DAYS} days`,
          detail: `Includes ${computerHours(TRIAL_SANDBOX_ALLOWANCE_CENTS)} cloud computer hours`,
        })),
        false,
      ],
    },
    { feature: "Source available", cells: included(true) },
  ] satisfies { feature: string; hint?: string; cells: PricingCell[] }[],
};

function planMarkdown(plan: PricingPlan) {
  return `## ${plan.name}

${plan.price}${plan.note ? ` (${plan.note})` : ""}

${plan.features.map((feature) => `- ${feature}`).join("\n")}

[${plan.action.label}](${new URL(plan.action.href, "https://orkbot.run").href})`;
}

export const PRICING_MARKDOWN = `# Ork pricing

${PRICING_PLANS.slice(0, 1).map(planMarkdown).join("\n\n")}

## Commercial self-hosting

Commercial use of new Ork work, including internal business automation, requires a paid license. Pricing is quoted individually. [Licensing and contact](https://orkbot.run/license/).

You pay the model, computer, and integration providers you choose to use.
`;
