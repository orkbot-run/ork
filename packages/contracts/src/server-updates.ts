// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { z } from "zod";

export const ServerUpdatePhaseSchema = z.enum([
  "updating",
  "preparing",
  "downloading",
  "restarting",
  "verifying",
  "recovering",
]);
export type ServerUpdatePhase = z.infer<typeof ServerUpdatePhaseSchema>;

export const ServerUpdatesCheckSchema = z.object({}).strict();
export const ServerUpdatesStatusSchema = z.object({
  available: z.boolean(),
  mode: z.enum(["manual", "automatic"]),
  channel: z.enum(["stable", "preview"]).nullable(),
  channelSelectable: z.boolean().optional(),
  currentRevision: z.string().max(128).nullable(),
  candidate: z
    .object({ revision: z.string().regex(/^[a-f0-9]{40}$/), version: z.string().min(1).max(200) })
    .nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  policyRevision: z.number().int().nonnegative(),
  lastRequest: z
    .object({
      /** The client's idempotency key correlates a response lost during API restart. */
      id: z.uuid(),
      revision: z.string().regex(/^[a-f0-9]{40}$/),
      state: z.enum(["submitting", "requested", "completed", "unknown", "failed"]),
      requestedAt: z.iso.datetime(),
      /** Optional because an independently pinned deployment service may not report phases. */
      phase: ServerUpdatePhaseSchema.optional(),
    })
    .nullable(),
  error: z.enum(["check-failed", "request-failed"]).nullable(),
});
export type ServerUpdatesStatus = z.infer<typeof ServerUpdatesStatusSchema>;
export const ServerUpdatesApplySchema = z
  .object({
    candidateRevision: z.string().regex(/^[a-f0-9]{40}$/),
    idempotencyKey: z.uuid(),
  })
  .strict();
export const ServerUpdatesPolicySchema = z
  .object({
    automatic: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
    channel: z.enum(["stable", "preview"]).optional(),
  })
  .strict();
