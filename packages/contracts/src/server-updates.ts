// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { z } from "zod";

export const ServerUpdatesCheckSchema = z.object({}).strict();
export const ServerUpdatesStatusSchema = z.object({
  available: z.boolean(),
  mode: z.enum(["manual", "automatic"]),
  channel: z.enum(["stable", "preview"]).nullable(),
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
      state: z.enum(["submitting", "requested", "unknown", "failed"]),
      requestedAt: z.iso.datetime(),
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
  })
  .strict();
