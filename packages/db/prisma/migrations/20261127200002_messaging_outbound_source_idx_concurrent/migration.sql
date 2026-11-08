-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

CREATE INDEX CONCURRENTLY messaging_outbound_protected_source_idx
ON messaging_outbound ("sourceMessageId", "identityId")
WHERE "requiredDeliveryVersion" > 0;
