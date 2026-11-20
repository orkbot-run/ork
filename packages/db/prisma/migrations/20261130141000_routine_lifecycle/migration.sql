-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

ALTER TABLE routines ADD COLUMN "resumeOnRestore" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE routines ADD COLUMN "completedOneShotAt" TIMESTAMP(3);

-- Retire prior successful schedules only when their latest scheduled occurrence succeeded.
WITH latest_one_shots AS (
  SELECT DISTINCT ON (routine.id) routine.id, run.id AS "runId", run."completedAt", run.status
  FROM routines routine
  JOIN runs run ON run."routineId" = routine.id
  WHERE routine.active = false
    AND routine.crons = ARRAY['@once']::text[]
    AND routine."nextRunAt" IS NULL
    AND routine."lastRunAt" IS NOT NULL
    AND run.trigger = 'routine'
    AND starts_with(run."clientNonce", 'routine-schedule:' || routine.id || ':')
  ORDER BY routine.id, run."createdAt" DESC, run.id DESC
)
UPDATE routines routine
SET "completedOneShotAt" = CASE WHEN latest.status = 'completed' THEN latest."completedAt" ELSE retry."completedAt" END
FROM latest_one_shots latest
LEFT JOIN runs retry ON retry."retryOfRunId" = latest."runId" AND retry.status = 'completed'
WHERE routine.id = latest.id
  AND (latest.status = 'completed' OR retry.id IS NOT NULL);
