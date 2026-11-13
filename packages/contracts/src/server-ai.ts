// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { z } from "zod";

export const AIModelsSchema = z
  .array(z.string().trim().min(1).max(512))
  .min(1)
  .max(1000)
  .refine((values) => new Set(values).size === values.length);
export const AIBudgetSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
export const ServerAIAccountSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.string(),
  models: AIModelsSchema,
  state: z.enum(["active", "disabled", "reconnect-required"]),
  revision: z.number().int(),
  concurrencyLimit: z.number().int().min(1).max(128),
  monthlyBudgetMicros: AIBudgetSchema,
});
export const WorkspaceAIConfigurationSchema = z.object({
  enabled: z.boolean(),
  allowedModels: AIModelsSchema,
  defaultModelId: z.string().min(1).max(512),
  isDefault: z.boolean(),
  fallback: z.boolean(),
  priority: z.number().int().min(0).max(1000),
  monthlyBudgetMicros: AIBudgetSchema,
});
export const WorkspaceAIAccountSchema = ServerAIAccountSchema.extend({
  enabled: z.boolean(),
  allowedModels: AIModelsSchema,
  defaultModelId: z.string().nullable(),
  isDefault: z.boolean(),
  fallback: z.boolean(),
  priority: z.number().int(),
  assignmentRevision: z.number().int(),
  monthlyBudgetMicros: AIBudgetSchema,
});
export const ServerAIStatusSchema = z.object({
  spaceId: z.string(),
  available: z.boolean(),
  workspaceMonthlyBudgetMicros: AIBudgetSchema,
  canManageServer: z.boolean(),
  canManageWorkspace: z.boolean(),
  accounts: z.array(ServerAIAccountSchema),
  connections: z.array(WorkspaceAIAccountSchema),
});
