-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

CREATE TABLE "installation_identity" (
  "id" TEXT PRIMARY KEY DEFAULT 'local', "issuer" TEXT NOT NULL,
  "publicKey" TEXT NOT NULL, "privateKeyCipher" TEXT NOT NULL, "keyFingerprint" TEXT NOT NULL,
  "operationId" TEXT NOT NULL, "challenge" TEXT NOT NULL, "requestedOrganizationId" TEXT, "localOrganizationId" TEXT, "enrollmentGrantId" TEXT, "enrollmentId" TEXT,
  "receiptCipher" TEXT, "serverId" TEXT, "centralOrganizationId" TEXT,
  "bindingVersion" INTEGER NOT NULL DEFAULT 1, "state" TEXT NOT NULL DEFAULT 'unregistered',
  "projectionGrant" TEXT, "verifiedAt" TIMESTAMP(3), "validUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "installation_identity_singleton" CHECK ("id" = 'local'),
  CONSTRAINT "installation_identity_version" CHECK ("bindingVersion" > 0)
);
CREATE TABLE "central_workspace_bindings" (
  "id" TEXT PRIMARY KEY, "serverId" TEXT NOT NULL, "centralOrganizationId" TEXT NOT NULL,
  "localOrganizationId" TEXT NOT NULL, "spaceId" TEXT NOT NULL UNIQUE, "operationId" TEXT NOT NULL UNIQUE,
  "bindingVersion" INTEGER NOT NULL, "permissionVersion" INTEGER NOT NULL,
  "state" TEXT NOT NULL, "members" JSONB NOT NULL, "verifiedAt" TIMESTAMP(3) NOT NULL, "validUntil" TIMESTAMP(3) NOT NULL,
  FOREIGN KEY ("spaceId", "localOrganizationId") REFERENCES "spaces"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "central_workspace_versions" CHECK ("bindingVersion" > 0 AND "permissionVersion" > 0)
);
CREATE UNIQUE INDEX "central_workspace_bindings_spaceId_localOrganizationId_key" ON "central_workspace_bindings"("spaceId", "localOrganizationId");
CREATE TABLE "central_session_bindings" (
  "sessionId" TEXT PRIMARY KEY REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "workspaceId" TEXT NOT NULL REFERENCES "central_workspace_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "centralSubject" TEXT NOT NULL, "membershipVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "central_session_bindings_workspaceId_centralSubject_idx" ON "central_session_bindings"("workspaceId", "centralSubject");
ALTER TABLE "installation_identity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "central_workspace_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "central_session_bindings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY installation_identity_system ON "installation_identity" USING ((SELECT app_rls_bypass()));
CREATE POLICY central_workspace_bindings_system ON "central_workspace_bindings" USING ((SELECT app_rls_bypass()));
CREATE POLICY central_session_bindings_system ON "central_session_bindings" USING ((SELECT app_rls_bypass()));

CREATE TABLE "central_workspace_access" (
  "workspaceId" TEXT NOT NULL REFERENCES "central_workspace_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "centralSubject" TEXT NOT NULL, "role" TEXT NOT NULL, "membershipVersion" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY ("workspaceId", "userId"),
  CONSTRAINT "central_workspace_access_role" CHECK ("role" IN ('admin', 'member'))
);
ALTER TABLE "central_workspace_access" ENABLE ROW LEVEL SECURITY;
CREATE POLICY central_workspace_access_system ON "central_workspace_access" USING ((SELECT app_rls_bypass()));

-- Preserve existing local membership settings while centrally revoked access fails closed.
CREATE FUNCTION app_central_workspace_access() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE binding public.central_workspace_bindings%ROWTYPE;
BEGIN
  IF public.app_rls_bypass() THEN RETURN true; END IF;
  SELECT * INTO binding FROM public.central_workspace_bindings
    WHERE "spaceId" = NULLIF(current_setting('app.space_id', true), '');
  IF NOT FOUND THEN RETURN true; END IF;
  RETURN binding.state = 'ready' AND binding."validUntil" > CURRENT_TIMESTAMP AND EXISTS (
    SELECT 1 FROM public.central_workspace_access access
    WHERE access."workspaceId" = binding.id
      AND access."userId" = NULLIF(current_setting('app.user_id', true), '') AND access.active
  );
END $$;

DO $$
DECLARE resource record;
BEGIN
  FOR resource IN SELECT relname FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relrowsecurity AND relkind = 'r'
  LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE USING ((SELECT public.app_central_workspace_access())) WITH CHECK ((SELECT public.app_central_workspace_access()))', resource.relname || '_central_authority', resource.relname);
  END LOOP;
END $$;
