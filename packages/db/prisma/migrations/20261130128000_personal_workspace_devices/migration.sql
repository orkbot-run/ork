-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

CREATE TABLE personal_workspace_devices (
  id TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES central_workspace_bindings(id) ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "centralSubject" TEXT NOT NULL,
  "membershipVersion" TEXT NOT NULL,
  "registryVersion" INTEGER NOT NULL CHECK ("registryVersion" > 0),
  "permissionVersion" INTEGER NOT NULL CHECK ("permissionVersion" > 0),
  "bindingVersion" INTEGER NOT NULL CHECK ("bindingVersion" > 0),
  "keyFingerprint" TEXT NOT NULL,
  "publicKey" TEXT NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX personal_workspace_devices_workspaceId_userId_idx ON personal_workspace_devices("workspaceId", "userId");
ALTER TABLE personal_workspace_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY personal_workspace_devices_system ON personal_workspace_devices USING ((SELECT app_rls_bypass()));
ALTER TABLE central_session_bindings ADD COLUMN "personalDeviceId" TEXT REFERENCES personal_workspace_devices(id) ON DELETE SET NULL;

-- This durable exception is created only from a personal-owner login and device possession proof.
CREATE FUNCTION app_personal_workspace_access(workspace TEXT, subject TEXT) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.personal_workspace_devices device
    JOIN public.central_workspace_bindings binding ON binding.id = device."workspaceId"
    JOIN public.central_workspace_access access ON access."workspaceId" = binding.id AND access."userId" = device."userId"
    JOIN public.installation_identity installation ON installation.id = 'local'
    WHERE binding.id = workspace AND device."userId" = subject AND device."revokedAt" IS NULL
      AND binding.state = 'ready' AND installation.state = 'ready' AND access.active
      AND access."centralSubject" = device."centralSubject"
      AND access."membershipVersion" = device."membershipVersion"
      AND binding."permissionVersion" = device."permissionVersion"
      AND binding."bindingVersion" = device."bindingVersion"
      AND installation."serverId" = binding."serverId" AND installation."centralOrganizationId" = binding."centralOrganizationId"
      AND installation."bindingVersion" = device."bindingVersion"
      AND installation."keyFingerprint" = device."keyFingerprint"
  );
$$;
CREATE OR REPLACE FUNCTION app_central_workspace_access() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE binding public.central_workspace_bindings%ROWTYPE; subject TEXT;
BEGIN
  IF public.app_rls_bypass() THEN RETURN true; END IF;
  SELECT * INTO binding FROM public.central_workspace_bindings
    WHERE "spaceId" = NULLIF(current_setting('app.space_id', true), '');
  IF NOT FOUND THEN RETURN true; END IF;
  subject := NULLIF(current_setting('app.user_id', true), '');
  RETURN binding.state = 'ready' AND EXISTS (
    SELECT 1 FROM public.central_workspace_access access
    WHERE access."workspaceId" = binding.id AND access."userId" = subject AND access.active
  ) AND (binding."validUntil" > CURRENT_TIMESTAMP OR public.app_personal_workspace_access(binding.id, subject));
END $$;

ALTER TABLE runs ADD COLUMN "personalDeviceId" TEXT;
CREATE OR REPLACE FUNCTION capture_workspace_run_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE binding public.central_workspace_bindings; admission public.central_workspace_access;
  device public.personal_workspace_devices; requested_device TEXT;
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
  IF FOUND THEN
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
