// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { z } from "zod";

export const ASK_DECISION_DETAIL_MAX_LENGTH = 4_000;

/** The gate supplies this contextual reason; models cannot choose it. */
export const ApprovalReasonSchema = z.enum([
  "scheduled_command",
  "outside_content_schedule",
  "webhook_trigger",
]);
export type ApprovalReason = z.infer<typeof ApprovalReasonSchema>;
