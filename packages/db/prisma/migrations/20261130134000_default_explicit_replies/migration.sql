-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

-- Existing modes have no marker distinguishing the old default from a saved choice.
-- Preserve those choices and existing run pins; only bots created without a mode inherit this.
ALTER TABLE bots ALTER COLUMN "replyMode" SET DEFAULT 'explicit';
