-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

-- Existing policies remain the default, including while older workers finish draining.
ALTER TABLE "workspace_model_policy"
  ADD COLUMN "additionalModels" JSONB NOT NULL DEFAULT '[]'::jsonb;
