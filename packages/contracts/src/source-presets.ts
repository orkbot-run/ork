// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import * as z from "zod";
import { IntegrationProviderIdSchema } from "./integration-settings.js";

export const SourcePresetIdSchema = IntegrationProviderIdSchema;
export const SourcePresetSchema = z.object({
  id: SourcePresetIdSchema,
  label: z.string().min(1).max(120),
  kind: z.enum(["mcp", "api", "graphql"]),
  endpoint: z.enum(["fixed", "input"]),
  credential: z.enum(["none", "optional", "required"]),
});
export type SourcePreset = z.infer<typeof SourcePresetSchema>;

/** Presets own their protocol configuration; clients supply only declared user inputs. */
export const SourcePresetInstallSchema = z.strictObject({
  presetId: SourcePresetIdSchema,
  name: z.string().trim().min(1).max(120),
  endpoint: z.string().trim().min(1).max(2048).optional(),
  credential: z.string().max(16_384).optional(),
});
export type SourcePresetInstall = z.infer<typeof SourcePresetInstallSchema>;
