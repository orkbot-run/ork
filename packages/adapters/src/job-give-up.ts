// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { getLogger, unwrapJobPayload } from "@orkbot/logging";

export interface ExhaustedJob {
  id: string;
  task_identifier: string;
  key: string | null;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  created_at: Date;
  last_error?: string | null;
}

export function publicJobType(type: string): string {
  return type === "run.interactive" ? "run.continue" : type;
}

/** Only metadata leaves the queue: never pass a job or its payload to the logger. */
export function reportJobGiveUp(job: ExhaustedJob, error?: unknown): void {
  if (job.attempts < job.max_attempts) return;
  const type = publicJobType(job.task_identifier);
  const { correlation } = unwrapJobPayload(job.payload);
  const lastError =
    error instanceof Error
      ? error.message
      : String(error ?? job.last_error ?? "Unknown job failure");
  getLogger().error("job.gave_up", new Error(lastError), {
    "job.type": type,
    "job.queue_id": job.id,
    "job.key": job.key,
    "job.id": correlation?.jobId,
    "trace.id": correlation?.traceId,
    "job.attempts": job.attempts,
    "job.max_attempts": job.max_attempts,
    "job.age_ms": Math.max(0, Date.now() - job.created_at.getTime()),
    "error.fingerprint": ["job.gave_up", type],
  });
}
