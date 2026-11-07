-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
-- Additive nullable fields preserve compatibility with the previous release.
ALTER TABLE "user" ADD COLUMN "accountDeletionClaimId" TEXT;
ALTER TABLE "user" ADD COLUMN "accountDeletionClaimedAt" TIMESTAMP(3);
