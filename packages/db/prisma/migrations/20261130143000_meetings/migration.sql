-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
-- SPDX-FileCopyrightText: 2026 Ork contributors

CREATE TABLE "meeting_sessions" (
  "id" TEXT PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "title" TEXT NOT NULL,
  "url" TEXT,
  "platform" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "error" TEXT,
  "scheduledAt" TIMESTAMP(3),
  "consentedAt" TIMESTAMP(3) NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "nextCheckAt" TIMESTAMP(3),
  "joinAttemptedAt" TIMESTAMP(3),
  "leaveRequestedAt" TIMESTAMP(3),
  "leaveSentAt" TIMESTAMP(3),
  "deleteRequestedAt" TIMESTAMP(3),
  "mediaDeletedAt" TIMESTAMP(3),
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "providerId" TEXT,
  "transcript" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX "meeting_sessions_providerId_key" ON "meeting_sessions"("providerId");
CREATE INDEX "meeting_sessions_spaceId_userId_botId_createdAt_idx"
  ON "meeting_sessions"("spaceId", "userId", "botId", "createdAt");
CREATE INDEX "meeting_sessions_nextCheckAt_idx" ON "meeting_sessions"("nextCheckAt");

ALTER TABLE "meeting_sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY meeting_sessions_tenant ON "meeting_sessions" USING (
  "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND
  "userId" = NULLIF(current_setting('app.user_id', true), '')
);
CREATE POLICY meeting_sessions_system ON "meeting_sessions" USING ((SELECT app_rls_bypass()));

CREATE TABLE "meeting_daily_usage" (
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "day" DATE NOT NULL,
  "used" INTEGER NOT NULL,
  PRIMARY KEY ("spaceId", "day")
);

ALTER TABLE "meeting_daily_usage" ENABLE ROW LEVEL SECURITY;
CREATE POLICY meeting_daily_usage_tenant ON "meeting_daily_usage" USING (
  "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND
  NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
);
CREATE POLICY meeting_daily_usage_system ON "meeting_daily_usage" USING ((SELECT app_rls_bypass()));
