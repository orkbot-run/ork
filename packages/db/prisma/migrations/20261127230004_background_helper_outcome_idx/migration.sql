-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

CREATE INDEX CONCURRENTLY "runs_background_helper_outcome_idx" ON runs ("updatedAt", id) WHERE trigger = 'tickets' AND "clientNonce" LIKE 'background-helper:%' AND "botOutcomeReturnedAt" IS NULL AND status IN ('completed', 'failed', 'cancelled');
