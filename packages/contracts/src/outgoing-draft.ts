// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import * as z from "zod";

export const OUTGOING_DRAFT_RECIPIENT_LIMIT = 2_048;
export const OUTGOING_DRAFT_SUBJECT_LIMIT = 998;
export const OUTGOING_DRAFT_BODY_LIMIT = 100_000;

const fields = {
  recipient: z.string().max(OUTGOING_DRAFT_RECIPIENT_LIMIT),
  subject: z.string().max(OUTGOING_DRAFT_SUBJECT_LIMIT).optional(),
  body: z.string().max(OUTGOING_DRAFT_BODY_LIMIT),
};

export const OutgoingDraftSchema = z.object({
  kind: z.enum(["email", "message"]),
  ...fields,
  recipientChanged: z.literal(true).optional(),
  reviewId: z.uuid().optional(),
});
export type OutgoingDraft = z.infer<typeof OutgoingDraftSchema>;

export const OutgoingDraftAnswerSchema = z.strictObject({
  outgoingDraft: z.strictObject({
    ...fields,
    recipient: fields.recipient.refine((value) => value.trim() && !/[\r\n\0]/u.test(value)),
    subject: fields.subject.refine((value) => value === undefined || !/[\r\n\0]/u.test(value)),
    body: fields.body.refine((value) => value.trim() && !value.includes("\0")),
  }),
  reviewId: z.uuid().optional(),
});
