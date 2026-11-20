// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import * as z from "zod";
import { Id } from "./ids.js";

export const UsageRangeSchema = z.enum(["today", "7d", "30d", "all"]);
export type UsageRange = z.infer<typeof UsageRangeSchema>;

export const UsageBreakdownInputSchema = z.strictObject({
  botId: Id.optional(),
  provider: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(300).optional(),
  range: UsageRangeSchema.default("30d"),
});
export type UsageBreakdownInput = z.infer<typeof UsageBreakdownInputSchema>;

/** A nullable quantity is unknown when a counted call omits it. */
export const UsageBreakdownTotalsSchema = z.object({
  runs: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
});
export type UsageTotals = z.infer<typeof UsageBreakdownTotalsSchema>;

const BotIdentitySchema = z.object({
  botId: Id,
  name: z.string().nullable(),
  deleted: z.boolean(),
});
const ModelIdentitySchema = z.object({ provider: z.string(), model: z.string() });

export const UsageBreakdownSchema = z.object({
  timezone: z.string(),
  range: UsageRangeSchema,
  from: z.iso.date().nullable(),
  to: z.iso.date(),
  totals: UsageBreakdownTotalsSchema,
  botOptions: z.array(BotIdentitySchema),
  modelOptions: z.array(ModelIdentitySchema),
  bots: z.array(
    UsageBreakdownTotalsSchema.extend(BotIdentitySchema.shape).extend({ botId: Id.nullable() }),
  ),
  models: z.array(UsageBreakdownTotalsSchema.extend(ModelIdentitySchema.shape)),
  overTimeUnit: z.enum(["day", "month"]),
  overTime: z.array(UsageBreakdownTotalsSchema.extend({ date: z.iso.date() })),
});
export type UsageBreakdown = z.infer<typeof UsageBreakdownSchema>;
