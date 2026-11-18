-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

-- Keep server-owned data separate from the Accounts entry that admits the user.
ALTER TABLE public.spaces ADD COLUMN "admissionWorkspaceId" TEXT;
CREATE INDEX "spaces_admissionWorkspaceId_idx" ON public.spaces ("admissionWorkspaceId");

CREATE OR REPLACE FUNCTION app_central_scope_is_managed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.central_workspace_bindings
    WHERE "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ) OR EXISTS (
    SELECT 1 FROM public.spaces
    WHERE id = NULLIF(current_setting('app.space_id', true), '')
      AND "admissionWorkspaceId" IS NOT NULL
  )
$$;

CREATE OR REPLACE FUNCTION app_central_workspace_access() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE binding public.central_workspace_bindings%ROWTYPE;
  space_id TEXT := NULLIF(current_setting('app.space_id', true), '');
  subject TEXT := NULLIF(current_setting('app.user_id', true), '');
  adopted_space public.spaces%ROWTYPE;
BEGIN
  IF public.app_rls_bypass() THEN RETURN true; END IF;
  SELECT * INTO binding FROM public.central_workspace_bindings WHERE "spaceId" = space_id;
  IF NOT FOUND THEN
    SELECT * INTO adopted_space FROM public.spaces WHERE id = space_id;
    IF adopted_space."admissionWorkspaceId" IS NULL THEN RETURN true; END IF;
    SELECT * INTO binding FROM public.central_workspace_bindings
      WHERE id = adopted_space."admissionWorkspaceId" AND "localOrganizationId" = adopted_space."organizationId";
    IF NOT FOUND OR NOT EXISTS (
      SELECT 1 FROM public.space_members
      WHERE "spaceId" = space_id AND "userId" = subject
    ) THEN RETURN false; END IF;
  END IF;
  RETURN binding.state = 'ready' AND EXISTS (
    SELECT 1 FROM public.central_workspace_access access
    WHERE access."workspaceId" = binding.id AND access."userId" = subject AND access.active
  ) AND (binding."validUntil" > CURRENT_TIMESTAMP OR public.app_personal_workspace_access(binding.id, subject));
END $$;

CREATE OR REPLACE FUNCTION capture_workspace_run_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE binding public.central_workspace_bindings; admission public.central_workspace_access;
  device public.personal_workspace_devices; requested_device TEXT;
  adopted_space public.spaces%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."spaceId" IS DISTINCT FROM OLD."spaceId" OR NEW."userId" IS DISTINCT FROM OLD."userId"
      OR NEW."centralWorkspaceId" IS DISTINCT FROM OLD."centralWorkspaceId"
      OR NEW."workspaceMembershipVersion" IS DISTINCT FROM OLD."workspaceMembershipVersion"
      OR NEW."personalDeviceId" IS DISTINCT FROM OLD."personalDeviceId" THEN
      RAISE EXCEPTION 'Run admission is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  NEW."personalDeviceId" := NULL;
  SELECT * INTO binding FROM public.central_workspace_bindings WHERE "spaceId" = NEW."spaceId";
  IF NOT FOUND THEN
    SELECT * INTO adopted_space FROM public.spaces WHERE id = NEW."spaceId";
    IF adopted_space."admissionWorkspaceId" IS NOT NULL THEN
      SELECT * INTO binding FROM public.central_workspace_bindings
        WHERE id = adopted_space."admissionWorkspaceId" AND "localOrganizationId" = adopted_space."organizationId";
      IF NOT FOUND OR NOT EXISTS (
        SELECT 1 FROM public.space_members
        WHERE "spaceId" = NEW."spaceId" AND "userId" = NEW."userId"
      ) THEN
        RAISE EXCEPTION 'Workspace admission unavailable' USING ERRCODE = '42501';
      END IF;
      NEW."requiredReaderVersion" := GREATEST(NEW."requiredReaderVersion", 6);
    END IF;
  END IF;
  IF binding.id IS NOT NULL THEN
    SELECT * INTO admission FROM public.central_workspace_access
      WHERE "workspaceId" = binding.id AND "userId" = NEW."userId" AND active;
    IF NOT FOUND OR binding.state <> 'ready' THEN
      RAISE EXCEPTION 'Workspace admission unavailable' USING ERRCODE = '42501';
    END IF;
    requested_device := NULLIF(current_setting('app.personal_device_id', true), '');
    SELECT candidate.* INTO device FROM public.personal_workspace_devices candidate
      JOIN public.installation_identity installation ON installation.id = 'local'
      WHERE candidate."workspaceId" = binding.id AND candidate."userId" = NEW."userId" AND candidate."revokedAt" IS NULL
        AND (requested_device IS NULL OR candidate.id = requested_device)
        AND candidate."centralSubject" = admission."centralSubject" AND candidate."membershipVersion" = admission."membershipVersion"
        AND candidate."permissionVersion" = binding."permissionVersion" AND candidate."bindingVersion" = binding."bindingVersion"
        AND installation.state = 'ready' AND installation."serverId" = binding."serverId" AND installation."centralOrganizationId" = binding."centralOrganizationId"
        AND installation."bindingVersion" = candidate."bindingVersion" AND installation."keyFingerprint" = candidate."keyFingerprint"
      ORDER BY candidate."createdAt", candidate.id LIMIT 1;
    IF FOUND THEN
      NEW."personalDeviceId" := device.id;
      NEW."requiredReaderVersion" := GREATEST(NEW."requiredReaderVersion", 5);
    ELSIF requested_device IS NOT NULL OR binding."validUntil" <= clock_timestamp() THEN
      RAISE EXCEPTION 'Workspace admission unavailable' USING ERRCODE = '42501';
    END IF;
    NEW."centralWorkspaceId" := binding.id;
    NEW."workspaceMembershipVersion" := admission."membershipVersion";
    NEW."requiredReaderVersion" := GREATEST(NEW."requiredReaderVersion", 4);
  ELSE
    NEW."centralWorkspaceId" := NULL;
    NEW."workspaceMembershipVersion" := NULL;
  END IF;
  RETURN NEW;
END $$;
