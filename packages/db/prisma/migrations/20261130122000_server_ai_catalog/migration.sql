-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

CREATE TABLE "ai_connection_administrators" (
  "accountKey" TEXT PRIMARY KEY, "bindingVersion" INTEGER NOT NULL CHECK ("bindingVersion" >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "server_ai_connections" (
  "id" TEXT PRIMARY KEY, "localOrganizationId" TEXT NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "label" TEXT NOT NULL, "provider" TEXT NOT NULL, "models" JSONB NOT NULL,
  "secretId" TEXT NOT NULL, "secretRef" TEXT NOT NULL, "state" TEXT NOT NULL DEFAULT 'active',
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "concurrencyLimit" INTEGER NOT NULL DEFAULT 8 CHECK ("concurrencyLimit" BETWEEN 1 AND 128),
  "monthlyBudgetMicros" BIGINT CHECK ("monthlyBudgetMicros" >= 0), "blockedUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "server_ai_connection_state" CHECK (state IN ('active', 'disabled', 'reconnect-required'))
);
CREATE INDEX "server_ai_connections_localOrganizationId_state_idx" ON "server_ai_connections"("localOrganizationId", "state");
CREATE TABLE "workspace_ai_connections" (
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "connectionId" TEXT NOT NULL REFERENCES "server_ai_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "available" BOOLEAN NOT NULL DEFAULT true, "enabled" BOOLEAN NOT NULL DEFAULT false,
  "allowedModels" JSONB NOT NULL, "defaultModelId" TEXT, "priority" INTEGER NOT NULL DEFAULT 0 CHECK ("priority" >= 0),
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0), "bindingVersion" INTEGER NOT NULL CHECK ("bindingVersion" >= 0),
  "monthlyBudgetMicros" BIGINT CHECK ("monthlyBudgetMicros" >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("spaceId", "connectionId")
);
CREATE TABLE "ai_workspace_policies" (
  "spaceId" TEXT PRIMARY KEY REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "monthlyBudgetMicros" BIGINT CHECK ("monthlyBudgetMicros" >= 0), "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0)
);
CREATE TABLE "ai_usage_reservations" (
  "operationId" TEXT PRIMARY KEY,
  "connectionId" TEXT NOT NULL REFERENCES "server_ai_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "modelId" TEXT NOT NULL, "userId" TEXT NOT NULL, "runId" TEXT, "period" TEXT NOT NULL,
  "reservedMicros" BIGINT NOT NULL CHECK ("reservedMicros" >= 0), "chargedMicros" BIGINT CHECK ("chargedMicros" >= 0),
  "accountRevision" INTEGER NOT NULL, "assignmentRevision" INTEGER NOT NULL, "bindingVersion" INTEGER NOT NULL,
  "leaseUntil" TIMESTAMP(3) NOT NULL, "completedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ai_usage_reservations_connectionId_period_idx" ON "ai_usage_reservations"("connectionId", "period");
CREATE INDEX "ai_usage_reservations_spaceId_period_idx" ON "ai_usage_reservations"("spaceId", "period");
CREATE INDEX "ai_usage_reservations_connectionId_completedAt_leaseUntil_idx" ON "ai_usage_reservations"("connectionId", "completedAt", "leaseUntil");

-- Only guarded backend operations may inspect credential references, delegation or accounting rows.
DO $$
DECLARE resource TEXT;
BEGIN
  FOREACH resource IN ARRAY ARRAY['ai_connection_administrators', 'server_ai_connections', 'workspace_ai_connections', 'ai_workspace_policies', 'ai_usage_reservations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', resource);
    EXECUTE format('CREATE POLICY %I ON %I USING ((SELECT public.app_rls_bypass())) WITH CHECK ((SELECT public.app_rls_bypass()))', resource || '_system', resource);
  END LOOP;
END $$;

-- Existing credentials retain their encrypted references and only the Spaces that already used them.
INSERT INTO "server_ai_connections" (id, "localOrganizationId", label, provider, models, "secretId", "secretRef", "updatedAt")
SELECT 'legacy:' || policy."organizationId", policy."organizationId", 'Workspace connection', policy.provider,
  jsonb_build_array(policy."modelId"), policy."secretId", policy."secretRef", policy."updatedAt"
FROM "workspace_model_policy" policy;
INSERT INTO "workspace_ai_connections" ("spaceId", "connectionId", enabled, "allowedModels", "defaultModelId", "bindingVersion", "updatedAt")
SELECT space.id, 'legacy:' || policy."organizationId", true, jsonb_build_array(policy."modelId"), policy."modelId", COALESCE(binding."bindingVersion", 0), CURRENT_TIMESTAMP
FROM "workspace_model_policy" policy JOIN spaces space ON space."organizationId" = policy."organizationId"
LEFT JOIN "central_workspace_bindings" binding ON binding."spaceId" = space.id
WHERE space."deletingAt" IS NULL;

CREATE FUNCTION mirror_legacy_ai_policy() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE organization TEXT; connection TEXT;
BEGIN
  organization := CASE WHEN TG_OP = 'DELETE' THEN OLD."organizationId" ELSE NEW."organizationId" END;
  connection := 'legacy:' || organization;
  IF EXISTS (SELECT 1 FROM public.central_workspace_bindings WHERE "localOrganizationId" = organization) THEN
    RAISE EXCEPTION 'Update required: AI accounts are managed on the installation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    UPDATE public.server_ai_connections SET state = 'disabled', revision = revision + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE id = connection;
    RETURN OLD;
  END IF;
  INSERT INTO public.server_ai_connections (id, "localOrganizationId", label, provider, models, "secretId", "secretRef", "updatedAt")
    VALUES (connection, organization, 'Workspace connection', NEW.provider, jsonb_build_array(NEW."modelId"), NEW."secretId", NEW."secretRef", CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, models = EXCLUDED.models,
      "secretId" = EXCLUDED."secretId", "secretRef" = EXCLUDED."secretRef", state = 'active',
      revision = server_ai_connections.revision + 1, "updatedAt" = CURRENT_TIMESTAMP;
  INSERT INTO public.workspace_ai_connections ("spaceId", "connectionId", enabled, "allowedModels", "defaultModelId", "bindingVersion", "updatedAt")
    SELECT id, connection, true, jsonb_build_array(NEW."modelId"), NEW."modelId", 0, CURRENT_TIMESTAMP FROM public.spaces
    WHERE "organizationId" = organization AND "deletingAt" IS NULL
    ON CONFLICT ("spaceId", "connectionId") DO UPDATE SET "allowedModels" = EXCLUDED."allowedModels", "defaultModelId" = EXCLUDED."defaultModelId", revision = workspace_ai_connections.revision + 1, "updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;
CREATE TRIGGER mirror_legacy_ai_policy AFTER INSERT OR UPDATE OR DELETE ON workspace_model_policy FOR EACH ROW EXECUTE FUNCTION mirror_legacy_ai_policy();

CREATE FUNCTION bind_existing_ai_assignments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.workspace_ai_connections SET "bindingVersion" = NEW."bindingVersion", revision = revision + 1
    WHERE "spaceId" = NEW."spaceId" AND "bindingVersion" = 0;
  RETURN NEW;
END $$;
CREATE TRIGGER bind_existing_ai_assignments AFTER INSERT ON central_workspace_bindings FOR EACH ROW EXECUTE FUNCTION bind_existing_ai_assignments();
