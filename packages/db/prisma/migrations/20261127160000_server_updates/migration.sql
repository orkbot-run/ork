-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
-- Additive: older releases neither read nor write these operator-only records.
CREATE TABLE "server_update_controls" (
  "id" TEXT PRIMARY KEY,
  "delegatedAccountKey" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "automatic" BOOLEAN NOT NULL DEFAULT false,
  "consentedAccountKey" TEXT,
  "consentedUserId" TEXT REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "policyRevision" INTEGER NOT NULL DEFAULT 0,
  "candidateBaseRevision" TEXT,
  "candidateRevision" TEXT,
  "candidateVersion" TEXT,
  "lastCheckedAt" TIMESTAMP(3),
  "checkFailed" BOOLEAN NOT NULL DEFAULT false,
  "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "server_update_requests" (
  "id" TEXT PRIMARY KEY,
  "installationId" TEXT NOT NULL REFERENCES "server_update_controls"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "idempotencyKey" TEXT NOT NULL,
  "revision" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "automatic" BOOLEAN NOT NULL,
  "policyRevision" INTEGER NOT NULL,
  "delegatedAccountKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "server_update_requests_installationId_idempotencyKey_key" ON "server_update_requests"("installationId", "idempotencyKey");
CREATE INDEX "server_update_requests_installationId_createdAt_idx" ON "server_update_requests"("installationId", "createdAt");
CREATE INDEX "server_update_requests_installationId_revision_idx" ON "server_update_requests"("installationId", "revision");
ALTER TABLE "server_update_controls" ENABLE ROW LEVEL SECURITY;
CREATE POLICY server_update_controls_system ON "server_update_controls" USING ((SELECT app_rls_bypass()));
ALTER TABLE "server_update_requests" ENABLE ROW LEVEL SECURITY;
CREATE POLICY server_update_requests_system ON "server_update_requests" USING ((SELECT app_rls_bypass()));
