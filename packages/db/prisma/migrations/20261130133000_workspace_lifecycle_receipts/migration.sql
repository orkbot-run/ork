-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

-- Deliberately no FK to the workspace: the server must still be able to retry
-- acknowledgement after deleting the final workspace row.
CREATE TABLE "workspace_lifecycle_receipts" (
  "operationId" TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "centralOrganizationId" TEXT NOT NULL,
  "keyFingerprint" TEXT NOT NULL,
  "bindingVersion" INTEGER NOT NULL CHECK ("bindingVersion" > 0),
  "permissionVersion" INTEGER NOT NULL CHECK ("permissionVersion" > 0),
  "kind" TEXT NOT NULL CHECK ("kind" IN ('archive', 'delete')),
  "localOrganizationId" TEXT NOT NULL,
  "rootSpaceId" TEXT NOT NULL,
  "spaceIds" JSONB NOT NULL CHECK (jsonb_typeof("spaceIds") = 'array'),
  "homeKeys" JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof("homeKeys") = 'array'),
  "homeStorageIds" JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof("homeStorageIds") = 'array'),
  "state" TEXT NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending', 'complete')),
  "claimId" TEXT,
  "claimUntil" TIMESTAMP(3),
  "lastSweepAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "workspace_lifecycle_receipt_claim_pair"
    CHECK (("claimId" IS NULL) = ("claimUntil" IS NULL))
);
CREATE INDEX "workspace_lifecycle_receipts_workspaceId_idx"
  ON "workspace_lifecycle_receipts"("workspaceId");
CREATE INDEX "workspace_lifecycle_receipts_serverId_state_lastSweepAt_idx"
  ON "workspace_lifecycle_receipts"("serverId", "state", "lastSweepAt");
ALTER TABLE "workspace_lifecycle_receipts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_lifecycle_receipts_system ON "workspace_lifecycle_receipts"
  USING ((SELECT app_rls_bypass()));
