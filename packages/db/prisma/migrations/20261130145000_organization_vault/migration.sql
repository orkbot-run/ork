-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

-- A workspace's organization type comes only from a verified Accounts login grant.
ALTER TABLE "central_workspace_bindings" ADD COLUMN "organizationType" TEXT;
ALTER TABLE "central_workspace_bindings" ADD CONSTRAINT "central_workspace_organization_type_check"
  CHECK ("organizationType" IS NULL OR "organizationType" IN ('personal', 'shared'));

CREATE TABLE "organization_vault_credentials" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT '',
  "note" TEXT NOT NULL DEFAULT '',
  "origin" TEXT NOT NULL,
  "auth" JSONB NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("organizationId", "name")
);

CREATE TABLE "organization_vault_grants" (
  "spaceId" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "bindingVersion" INTEGER NOT NULL CHECK ("bindingVersion" >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("spaceId", "organizationId"),
  FOREIGN KEY ("spaceId", "organizationId") REFERENCES "spaces"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "organization_vault_grants_organizationId_idx" ON "organization_vault_grants"("organizationId");

-- Only guarded server operations may inspect secrets or workspace grants.
ALTER TABLE "organization_vault_credentials" ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_vault_credentials_system ON "organization_vault_credentials"
  USING ((SELECT public.app_rls_bypass())) WITH CHECK ((SELECT public.app_rls_bypass()));
ALTER TABLE "organization_vault_grants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_vault_grants_system ON "organization_vault_grants"
  USING ((SELECT public.app_rls_bypass())) WITH CHECK ((SELECT public.app_rls_bypass()));

-- Read access follows the current workspace grant, the signed binding and admission.
-- Only guarded server-side administration may change secrets or grants.
CREATE FUNCTION app_organization_vault_readable(organization_id TEXT) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.app_central_workspace_access() AND EXISTS (
    SELECT 1 FROM public.spaces s
    JOIN public.central_workspace_bindings b
      ON (b."spaceId" = s.id OR (b.id = s."admissionWorkspaceId" AND b."localOrganizationId" = s."organizationId"))
    JOIN public.installation_identity i ON i.id = 'local'
    JOIN public.organization_vault_grants g ON g."spaceId" = s.id
    WHERE s.id = NULLIF(current_setting('app.space_id', true), '')
      AND s."organizationId" = organization_id AND s."deletingAt" IS NULL
      AND b."localOrganizationId" = organization_id AND b."organizationType" = 'shared'
      AND b.state = 'ready' AND b."validUntil" > CURRENT_TIMESTAMP
      AND i.state = 'ready' AND i."serverId" = b."serverId"
      AND i."centralOrganizationId" = b."centralOrganizationId"
      AND i."localOrganizationId" = b."localOrganizationId" AND i."bindingVersion" = b."bindingVersion"
      AND g."organizationId" = organization_id AND g."bindingVersion" = b."bindingVersion"
  )
$$;
CREATE POLICY organization_vault_credentials_read ON "organization_vault_credentials" FOR SELECT
  USING (public.app_organization_vault_readable("organizationId"));

-- A company workspace must not fall back to the member's personal vault, even through
-- an older client or a direct query. An unknown managed organization fails closed.
CREATE FUNCTION app_personal_vault_allowed() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  current_space TEXT := NULLIF(current_setting('app.space_id', true), '');
  admission public.central_workspace_bindings%ROWTYPE;
  local_space public.spaces%ROWTYPE;
BEGIN
  IF public.app_rls_bypass() THEN RETURN true; END IF;
  SELECT * INTO admission FROM public.central_workspace_bindings WHERE "spaceId" = current_space;
  IF NOT FOUND THEN
    SELECT * INTO local_space FROM public.spaces WHERE id = current_space;
    IF NOT FOUND THEN RETURN false; END IF;
    IF local_space."admissionWorkspaceId" IS NULL THEN RETURN true; END IF;
    SELECT * INTO admission FROM public.central_workspace_bindings
      WHERE id = local_space."admissionWorkspaceId" AND "localOrganizationId" = local_space."organizationId";
    IF NOT FOUND THEN RETURN false; END IF;
  END IF;
  RETURN admission."organizationType" = 'personal' AND EXISTS (
    SELECT 1 FROM public.installation_identity i
    WHERE i.id = 'local' AND i.state = 'ready' AND i."serverId" = admission."serverId"
      AND i."centralOrganizationId" = admission."centralOrganizationId"
      AND i."localOrganizationId" = admission."localOrganizationId"
      AND i."bindingVersion" = admission."bindingVersion"
  );
END $$;
CREATE POLICY vault_credentials_personal_scope ON "vault_credentials" AS RESTRICTIVE
  USING ((SELECT public.app_personal_vault_allowed()))
  WITH CHECK ((SELECT public.app_personal_vault_allowed()));

-- The earlier managed-workspace isolation also blocks account-wide rows. Personal
-- organizations intentionally retain those rows; shared organizations still cannot read them.
ALTER POLICY vault_credentials_central_resource ON "vault_credentials"
  USING ((SELECT public.app_rls_bypass()) OR NOT (SELECT public.app_central_scope_is_managed())
    OR "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    OR ("spaceId" IS NULL AND (SELECT public.app_personal_vault_allowed())))
  WITH CHECK ((SELECT public.app_rls_bypass()) OR NOT (SELECT public.app_central_scope_is_managed())
    OR "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    OR ("spaceId" IS NULL AND (SELECT public.app_personal_vault_allowed())));
