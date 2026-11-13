-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

ALTER TABLE "installation_identity"
  ADD COLUMN "transportOwnerId" TEXT,
  ADD COLUMN "transportLeaseUntil" TIMESTAMP(3),
  ADD CONSTRAINT "installation_transport_owner_pair"
    CHECK (("transportOwnerId" IS NULL) = ("transportLeaseUntil" IS NULL));
