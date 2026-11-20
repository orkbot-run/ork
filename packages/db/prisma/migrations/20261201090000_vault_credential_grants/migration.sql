-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

CREATE UNIQUE INDEX "organization_vault_credentials_id_organizationId_key"
  ON "organization_vault_credentials"("id", "organizationId");
CREATE TABLE "organization_vault_credential_grants" (
  "credentialId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "bindingVersion" INTEGER NOT NULL CHECK ("bindingVersion" >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("credentialId", "spaceId"),
  FOREIGN KEY ("credentialId", "organizationId") REFERENCES "organization_vault_credentials"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("spaceId", "organizationId") REFERENCES "spaces"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "organization_vault_credential_workspace_grant_fkey" FOREIGN KEY ("spaceId", "organizationId") REFERENCES "organization_vault_grants"("spaceId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "organization_vault_credential_grants_spaceId_organizationId_idx"
  ON "organization_vault_credential_grants"("spaceId", "organizationId");

-- Preserve only access that was already granted, for secrets that already existed.
INSERT INTO "organization_vault_credential_grants" ("credentialId", "spaceId", "organizationId", "bindingVersion")
SELECT c.id, g."spaceId", g."organizationId", g."bindingVersion"
FROM "organization_vault_credentials" c
JOIN "organization_vault_grants" g ON g."organizationId" = c."organizationId";

ALTER TABLE "organization_vault_credential_grants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_vault_credential_grants_system ON "organization_vault_credential_grants"
  USING ((SELECT public.app_rls_bypass())) WITH CHECK ((SELECT public.app_rls_bypass()));

CREATE FUNCTION public.app_organization_vault_credential_readable(credential_id TEXT, organization_id TEXT)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.app_organization_vault_readable(organization_id) AND EXISTS (
    SELECT 1 FROM public.organization_vault_credential_grants g
    JOIN public.installation_identity i ON i.id = 'local'
    WHERE g."credentialId" = credential_id
      AND g."organizationId" = organization_id
      AND g."spaceId" = NULLIF(current_setting('app.space_id', true), '')
      AND g."bindingVersion" = i."bindingVersion"
  )
$$;
ALTER POLICY organization_vault_credentials_read ON "organization_vault_credentials"
  USING (public.app_organization_vault_credential_readable("id", "organizationId"));
