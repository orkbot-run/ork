-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

-- Keep revoked account IDs so an explicit pin fails instead of switching to the default.
ALTER TABLE bots ADD COLUMN "modelConnectionId" TEXT;
ALTER TABLE runs ADD COLUMN "modelConnectionId" TEXT;
