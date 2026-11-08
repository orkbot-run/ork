-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

CREATE INDEX CONCURRENTLY messaging_outbound_unresolved_identity_idx
ON messaging_outbound ("identityId", status)
WHERE "identityId" IS NOT NULL AND
  (status = 'uncertain' OR (status = 'sent' AND "providerHandle" IS NULL));
