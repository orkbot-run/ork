-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
-- SPDX-FileCopyrightText: 2026 Ork contributors

ALTER TABLE server_ai_connections ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "defaultModelId" TEXT, ADD COLUMN "defaultAllowedModels" JSONB;
ALTER TABLE ai_workspace_policies ADD COLUMN "overridesModels" BOOLEAN NOT NULL DEFAULT false;

-- Freeze the existing choice without changing any assignments, budgets, or credentials.
WITH chosen AS (
  SELECT DISTINCT ON (account."localOrganizationId") account.id, assignment."defaultModelId", assignment."allowedModels"
  FROM server_ai_connections account
  JOIN workspace_ai_connections assignment ON assignment."connectionId" = account.id
  WHERE assignment.available AND assignment.enabled AND assignment."isDefault"
    AND assignment."defaultModelId" IS NOT NULL
  ORDER BY account."localOrganizationId", account."createdAt", account.id, assignment."spaceId"
)
UPDATE server_ai_connections account SET "isDefault" = true,
  "defaultModelId" = chosen."defaultModelId", "defaultAllowedModels" = chosen."allowedModels" FROM chosen WHERE account.id = chosen.id;

-- An older installation may already have differing Space assignments or limits. Keep these
-- explicit differences independent when the operator changes the server default later.
WITH model_sets AS (
  SELECT space."organizationId", assignment."spaceId",
    jsonb_agg(jsonb_build_array(assignment."connectionId", assignment.available, assignment.enabled,
      assignment."allowedModels", assignment."defaultModelId", assignment."isDefault",
      assignment.fallback, assignment.priority, assignment."monthlyBudgetMicros")
      ORDER BY assignment."connectionId") AS settings
  FROM workspace_ai_connections assignment JOIN spaces space ON space.id = assignment."spaceId"
  GROUP BY space."organizationId", assignment."spaceId"
), baseline AS (
  SELECT DISTINCT ON (account."localOrganizationId") account."localOrganizationId", model_sets.settings
  FROM server_ai_connections account
  JOIN workspace_ai_connections assignment ON assignment."connectionId" = account.id
  JOIN model_sets ON model_sets."spaceId" = assignment."spaceId"
  WHERE account."isDefault" AND assignment.available AND assignment.enabled AND assignment."isDefault"
    AND assignment."defaultModelId" = account."defaultModelId"
    AND assignment."allowedModels" = account."defaultAllowedModels"
  ORDER BY account."localOrganizationId", assignment."spaceId"
)
INSERT INTO ai_workspace_policies ("spaceId", "overridesModels")
SELECT model_sets."spaceId", true FROM model_sets
JOIN baseline ON baseline."localOrganizationId" = model_sets."organizationId"
WHERE model_sets.settings IS DISTINCT FROM baseline.settings
ON CONFLICT ("spaceId") DO UPDATE SET "overridesModels" = true;

CREATE UNIQUE INDEX server_ai_connections_one_default ON server_ai_connections ("localOrganizationId")
  WHERE "isDefault";

-- New workspaces inherit the installation-owned default even if no client opens settings.
CREATE FUNCTION inherit_server_ai_default() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.workspace_ai_connections
    ("spaceId", "connectionId", available, enabled, "allowedModels", "defaultModelId",
     "isDefault", "bindingVersion", "updatedAt")
  SELECT NEW."spaceId", account.id, true, true, COALESCE(account."defaultAllowedModels", account.models), account."defaultModelId",
    true, NEW."bindingVersion", CURRENT_TIMESTAMP
  FROM public.server_ai_connections account
  WHERE account."localOrganizationId" = NEW."localOrganizationId" AND account."isDefault"
    AND account.state = 'active' AND account."defaultModelId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.workspace_ai_connections existing
      WHERE existing."spaceId" = NEW."spaceId" AND existing.available AND existing.enabled
        AND existing."isDefault")
  ON CONFLICT ("spaceId", "connectionId") DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER inherit_server_ai_default AFTER INSERT ON central_workspace_bindings
FOR EACH ROW EXECUTE FUNCTION inherit_server_ai_default();

-- Server-owned Spaces share the exact verified admission anchor, but own their model overrides.
CREATE FUNCTION inherit_local_space_ai_default() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.workspace_ai_connections
    ("spaceId", "connectionId", available, enabled, "allowedModels", "defaultModelId",
     "isDefault", "bindingVersion", "updatedAt")
  SELECT NEW.id, account.id, true, true, COALESCE(account."defaultAllowedModels", account.models),
    account."defaultModelId", true, binding."bindingVersion", CURRENT_TIMESTAMP
  FROM public.server_ai_connections account
  JOIN public.central_workspace_bindings binding ON binding.id = NEW."admissionWorkspaceId"
    AND binding."localOrganizationId" = NEW."organizationId"
  WHERE account."localOrganizationId" = NEW."organizationId" AND account."isDefault"
    AND account.state = 'active' AND account."defaultModelId" IS NOT NULL
  ON CONFLICT ("spaceId", "connectionId") DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER inherit_local_space_ai_default AFTER INSERT ON spaces
FOR EACH ROW EXECUTE FUNCTION inherit_local_space_ai_default();
