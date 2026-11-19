-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

BEGIN;
ALTER TABLE "computers" ADD COLUMN "bootHeartbeatAt" TIMESTAMP(3);
CREATE INDEX "computers_kind_provider_ref_idx" ON "computers" ("kind", "providerRef");

CREATE TABLE "computer_orphan_cleanup" (
  "kind" TEXT NOT NULL,
  "providerRef" TEXT NOT NULL,
  "connection" TEXT NOT NULL,
  "providerInstanceId" TEXT NOT NULL DEFAULT '',
  "computerId" TEXT NOT NULL,
  "homeKey" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseId" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  CONSTRAINT "computer_orphan_cleanup_pkey" PRIMARY KEY ("kind", "providerRef", "connection", "providerInstanceId")
);
CREATE INDEX "computer_orphan_cleanup_computer_lease_idx"
  ON "computer_orphan_cleanup" ("computerId", "leaseExpiresAt");
CREATE INDEX "computer_orphan_cleanup_due_idx"
  ON "computer_orphan_cleanup" ("failedAt", "nextAttemptAt");
ALTER TABLE "computer_orphan_cleanup" ENABLE ROW LEVEL SECURITY;
CREATE POLICY computer_orphan_cleanup_system ON "computer_orphan_cleanup" USING ((SELECT app_rls_bypass()));
COMMIT;
