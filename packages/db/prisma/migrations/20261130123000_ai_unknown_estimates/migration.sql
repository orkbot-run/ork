-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

ALTER TABLE "ai_usage_reservations" ADD COLUMN "estimateKnown" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "ai_usage_reservations_unknown_period_idx" ON "ai_usage_reservations"(period) WHERE NOT "estimateKnown" AND "chargedMicros" IS NULL;
