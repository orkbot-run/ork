-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

ALTER TABLE "server_ai_connections" ADD COLUMN "credentialVersion" INTEGER NOT NULL DEFAULT 1 CHECK ("credentialVersion" > 0);
