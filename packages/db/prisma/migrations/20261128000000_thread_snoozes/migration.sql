-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

CREATE TABLE "thread_snoozes" (
  "threadId" text NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "until" timestamptz(3),
  "suppressCompletedThrough" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("threadId", "userId")
);
CREATE INDEX "thread_snoozes_userId_until_idx" ON "thread_snoozes" ("userId", "until");
ALTER TABLE "thread_snoozes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY thread_snoozes_tenant ON "thread_snoozes" USING (
  "userId" = NULLIF(current_setting('app.user_id', true), '') AND EXISTS (
    SELECT 1 FROM threads t WHERE t.id = "thread_snoozes"."threadId"
      AND t."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  )
);
CREATE POLICY thread_snoozes_system ON "thread_snoozes" USING (app_rls_bypass());
