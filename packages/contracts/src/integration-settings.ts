// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; neutral integration contracts follow LICENSE.md.

import * as z from "zod";

/** Opaque adapter ids retain their persisted spelling and case. */
export const IntegrationProviderIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/i);
export const ConfiguredIntegrationSchema = z.object({ id: IntegrationProviderIdSchema });
export type ConfiguredIntegration = z.infer<typeof ConfiguredIntegrationSchema>;

/** Legacy setup remains disabled; provider-specific secret validation belongs to adapters. */
export const IntegrationProviderConfigSchema = z
  .object({ provider: IntegrationProviderIdSchema })
  .catchall(z.string().max(16_384))
  .superRefine((value, context) => {
    const entries = Object.entries(value);
    const invalidKey = entries.some(
      ([key]) => !key || key.length > 64 || ["__proto__", "constructor", "prototype"].includes(key),
    );
    const bytes = entries.reduce(
      (total, [key, field]) =>
        total +
        new TextEncoder().encode(key).byteLength +
        new TextEncoder().encode(field).byteLength,
      0,
    );
    if (entries.length > 16 || invalidKey || bytes > 65_536)
      context.addIssue({ code: "custom", message: "Invalid integration configuration" });
  });
export type IntegrationProviderConfig = z.infer<typeof IntegrationProviderConfigSchema>;
export type IntegrationProviderId = z.infer<typeof IntegrationProviderIdSchema>;
export const IntegrationSetupStateSchema = z.object({
  canConfigure: z.boolean(),
  needsSetup: z.boolean(),
  webUrl: z.string().url(),
  providers: z.array(z.object({ id: IntegrationProviderIdSchema, configured: z.boolean() })),
});
export type IntegrationSetupState = z.infer<typeof IntegrationSetupStateSchema>;
