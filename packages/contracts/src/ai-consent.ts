// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is retained; send target consent additions follow LICENSE.md.
// Modified by Ork contributors: canonical domain links now use ork.run.
import * as z from "zod";
import { SettingsScopeSchema } from "./settings-scope.js";

export const AI_DISCLOSURE_VERSION = "2026-09-14";
export const AI_PRIVACY_URL = "https://ork.run/privacy/";
export const AiDataUseSchema = z.enum(["model", "voice", "memory"]);
export type AiDataUse = z.infer<typeof AiDataUseSchema>;
export const AI_DATA_DISCLOSURES: Record<AiDataUse, string> = {
  model:
    "Messages, chat history, bot instructions, memories, attachments, screenshots and connected-app content are sent to run your bots, including routines.",
  voice:
    "Your recordings are sent for transcription, and text you play is sent to generate speech.",
  memory:
    "Conversation summaries, memories, searches and bot and Space IDs are sent to store and recall context.",
};
export const SEND_ROUTINE_LIMIT = 64;
export const AiConsentTargetSchema = z.object({
  botId: z.string().optional(),
  groupId: z.string().optional(),
  routineId: z.string().optional(),
  routineIds: z.array(z.string()).max(SEND_ROUTINE_LIMIT).optional(),
  /** Which copy of the member's settings names the recipients. */
  settingsScope: SettingsScopeSchema.optional(),
});
export const AiConsentQuerySchema = z
  .object({
    ...AiConsentTargetSchema.shape,
    uses: z.array(AiDataUseSchema).optional(),
  })
  .default({});
export type AiConsentQuery = z.infer<typeof AiConsentQuerySchema>;
export const AiRecipientSchema = z.object({
  key: z.string(),
  name: z.string(),
  use: AiDataUseSchema,
  detail: z.string(),
  privacyUrl: z.string().url().optional(),
  allowed: z.boolean(),
});
export type AiRecipient = z.infer<typeof AiRecipientSchema>;
export const AiConsentStatusSchema = z.object({
  scope: z.string(),
  version: z.string(),
  recipients: z.array(AiRecipientSchema),
  privacyUrl: z.string().url().optional(),
});
export type AiConsentStatus = z.infer<typeof AiConsentStatusSchema>;
export const AI_CONSENT_REQUIRED = "Review AI data sharing in Account settings before continuing.";
