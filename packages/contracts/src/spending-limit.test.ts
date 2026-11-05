// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it } from "vitest";
import { appContract } from "./rpc.js";
import { SpendingLimitSchema } from "./spending-limit.js";

const limit = { amount: 125.29, currency: "PLN", period: "monthly" };

describe("account spending limit contract", () => {
  it.each(["USD", "EUR", "GBP", "ILS", "PLN"])("accepts %s with each reset period", (currency) => {
    for (const period of ["daily", "weekly", "monthly", "never"])
      expect(SpendingLimitSchema.parse({ ...limit, currency, period })).toEqual({
        ...limit,
        currency,
        period,
      });
  });

  it("accepts a zero budget and exact decimal amounts", () => {
    for (const amount of [0, 0.01, 0.29, 1.1, 1_000, 999_999_999_999.99])
      expect(SpendingLimitSchema.parse({ ...limit, amount }).amount).toBe(amount);
  });

  it.each([-1, 1.001, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_000_000])(
    "rejects invalid amount %s",
    (amount) => {
      expect(SpendingLimitSchema.safeParse({ ...limit, amount }).success).toBe(false);
    },
  );

  it("rejects unsupported currencies, reset periods, and coercion", () => {
    expect(SpendingLimitSchema.safeParse({ ...limit, currency: "JPY" }).success).toBe(false);
    expect(SpendingLimitSchema.safeParse({ ...limit, period: "yearly" }).success).toBe(false);
    expect(SpendingLimitSchema.safeParse({ ...limit, amount: "100" }).success).toBe(false);
  });

  it("permits removing the limit without accepting another account or Space", () => {
    const get = appContract.spendingLimit.get["~orpc"].inputSchema!;
    const set = appContract.spendingLimit.set["~orpc"].inputSchema!;
    expect(get.parse({})).toEqual({});
    expect(set.parse({ limit })).toEqual({ limit });
    expect(set.parse({ limit: null })).toEqual({ limit: null });
    for (const selector of [{ scope: "space" }, { userId: "another-user" }, { spaceId: "space" }]) {
      expect(get.safeParse(selector).success).toBe(false);
      expect(set.safeParse({ limit, ...selector }).success).toBe(false);
    }
  });
});
