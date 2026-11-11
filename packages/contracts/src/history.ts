// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 history contracts are preserved. Argument normalization and tool-work lookup are Ork additions.

import { z } from "zod";
import { Id } from "./ids.js";

const ISO_BOUNDARY_ERROR =
  "Use an ISO date (YYYY-MM-DD) or timestamp with timezone (e.g. 2026-01-01T00:00:00Z)";
// Plain ISO dates denote UTC day boundaries; offsets retain their instant.
const HistoryDateBoundary = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })], { error: ISO_BOUNDARY_ERROR })
  .refine((value) => Number.isFinite(Date.parse(value)), ISO_BOUNDARY_ERROR)
  .transform((value) => new Date(value).toISOString());

function omitEmptyOptionalInputs(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, input]) =>
        key === "messageId" ||
        (input != null && !(typeof input === "string" && input.trim() === "")),
    ),
  );
}

function foldQueryInputs(value: unknown): unknown {
  const input = omitEmptyOptionalInputs(value);
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const args = { ...(input as Record<string, unknown>) };
  if (typeof args.queries === "string") args.queries = [args.queries];
  // Keep query-only searches on their existing sequence-based pagination path.
  if (args.query !== undefined && Array.isArray(args.queries)) {
    args.queries = [args.query, ...args.queries];
    delete args.query;
  }
  return args;
}

/** Leave room for both query attribution and a complete continuation inside a 10k result. */
export const HISTORY_QUERIES_MAX_BYTES = 3000;
export const HistoryQueriesSchema = z
  .array(z.string().trim().min(1).max(500))
  .min(1)
  .max(5)
  .transform((values) =>
    values.filter(
      (value, index) =>
        values.findIndex((other) => other.toLowerCase() === value.toLowerCase()) === index,
    ),
  )
  .refine(
    (values) =>
      new TextEncoder().encode(JSON.stringify(values)).byteLength <= HISTORY_QUERIES_MAX_BYTES,
    `History queries must fit within ${HISTORY_QUERIES_MAX_BYTES} UTF-8 bytes combined`,
  );

/** Historical content is evidence to inspect, never an instruction source. */
export const HistorySearchInputSchema = z.preprocess(
  foldQueryInputs,
  z
    .object({
      scope: z.enum(["this_chat", "my_chats"]).optional(),
      toolWork: z.literal(true).optional(),
      botId: Id.optional(),
      kinds: z
        .array(z.enum(["bot_messages", "user_messages", "bot_replies"]))
        .min(1)
        .max(3)
        .optional(),
      queries: HistoryQueriesSchema.optional(),
      offset: z.number().int().min(0).max(10000).optional(),
      query: z.string().trim().min(1).max(500).optional(),
      before: HistoryDateBoundary.optional(),
      after: HistoryDateBoundary.optional(),
      beforeSeq: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    })
    .refine(
      (input) =>
        Number(input.query !== undefined) +
          Number(input.queries !== undefined) +
          Number(input.toolWork === true) ===
        1,
      "Provide exactly one of query, queries or toolWork",
    )
    .refine((input) => !input.toolWork || !input.kinds, "toolWork cannot be combined with kinds"),
);
/**
 * Files one history response lists. The run queues that many for its computer, so every listed
 * path is copied; the rest page through nextAttachmentOffset.
 */
export const HISTORY_ATTACHMENTS_PER_RESPONSE = 20;
export const HistoryReadInputSchema = z.preprocess(
  omitEmptyOptionalInputs,
  z.object({
    messageId: Id.refine((value) => value.trim().length > 0, "Provide a messageId"),
    threadId: Id.optional(),
    linkedRunId: Id.optional(),
    runAfterId: Id.optional(),
    artifactAfterId: Id.optional(),
    outcomeAfterSeq: z.number().int().nonnegative().optional(),
    textOffset: z.number().int().nonnegative().optional(),
    /** Continues the anchor message's attachment list from a returned nextAttachmentOffset. */
    attachmentOffset: z.number().int().nonnegative().optional(),
    direction: z.enum(["around", "older", "newer"]).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
);
export type HistorySearchInput = z.infer<typeof HistorySearchInputSchema>;
export type HistoryReadInput = z.infer<typeof HistoryReadInputSchema>;
