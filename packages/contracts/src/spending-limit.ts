// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import * as z from "zod";

export const MAX_SPENDING_AMOUNT = 999_999_999_999.99;

export const SpendingCurrencySchema = z.enum(["USD", "EUR", "GBP", "ILS", "PLN"]);
export const SpendingPeriodSchema = z.enum(["daily", "weekly", "monthly", "never"]);

export const SpendingLimitSchema = z.strictObject({
  amount: z
    .number()
    .min(0)
    .max(MAX_SPENDING_AMOUNT)
    .refine((amount) => Number(amount.toFixed(2)) === amount, "Use at most two decimal places."),
  currency: SpendingCurrencySchema,
  period: SpendingPeriodSchema,
});

export const SpendingLimitStateSchema = z.strictObject({
  limit: SpendingLimitSchema.nullable(),
  spent: z.number().nonnegative(),
});

export type SpendingCurrency = z.infer<typeof SpendingCurrencySchema>;
export type SpendingPeriod = z.infer<typeof SpendingPeriodSchema>;
export type SpendingLimit = z.infer<typeof SpendingLimitSchema>;
export type SpendingLimitState = z.infer<typeof SpendingLimitStateSchema>;
