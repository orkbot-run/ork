-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

-- Preserve installations with existing model connections; empty installations need an admin choice.
ALTER TABLE "installation_identity" ADD COLUMN "modelSetupMode" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "installation_identity" ADD CONSTRAINT "installation_identity_model_setup_mode"
  CHECK ("modelSetupMode" IN ('pending', 'organization', 'personal', 'legacy'));

UPDATE "installation_identity" AS installation
SET "modelSetupMode" = 'legacy'
WHERE EXISTS (
  SELECT 1 FROM "server_ai_connections" AS connection
  WHERE connection."localOrganizationId" = installation."localOrganizationId"
) OR EXISTS (
  SELECT 1
  FROM "central_workspace_bindings" AS binding
  JOIN "central_workspace_access" AS access ON access."workspaceId" = binding.id
  JOIN "user_model_credentials" AS credential ON credential."userId" = access."userId"
  WHERE binding."localOrganizationId" = installation."localOrganizationId"
);
