-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
-- SPDX-FileCopyrightText: 2026 Ork contributors

-- Sole statement to allow a concurrent build on an active usage ledger.
CREATE INDEX CONCURRENTLY "usage_records_spaceId_userId_botId_createdAt_idx"
  ON "usage_records" ("spaceId", "userId", "botId", "createdAt");
