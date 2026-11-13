-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

ALTER TABLE runs ADD COLUMN "centralWorkspaceId" TEXT,
  ADD COLUMN "workspaceMembershipVersion" TEXT;

-- Existing queued work has no captured central admission. A new reader must refuse it.
UPDATE runs SET "requiredReaderVersion" = GREATEST("requiredReaderVersion", 4)
WHERE "spaceId" IN (SELECT "spaceId" FROM central_workspace_bindings);

CREATE FUNCTION capture_workspace_run_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE binding public.central_workspace_bindings; admission public.central_workspace_access;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."spaceId" IS DISTINCT FROM OLD."spaceId" OR NEW."userId" IS DISTINCT FROM OLD."userId"
      OR NEW."centralWorkspaceId" IS DISTINCT FROM OLD."centralWorkspaceId"
      OR NEW."workspaceMembershipVersion" IS DISTINCT FROM OLD."workspaceMembershipVersion" THEN
      RAISE EXCEPTION 'Run admission is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO binding FROM public.central_workspace_bindings WHERE "spaceId" = NEW."spaceId";
  IF FOUND THEN
    SELECT * INTO admission FROM public.central_workspace_access
      WHERE "workspaceId" = binding.id AND "userId" = NEW."userId" AND active;
    IF NOT FOUND OR binding.state <> 'ready' OR binding."validUntil" <= clock_timestamp() THEN
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
-- Run before the reader fence so an old reader cannot claim newly managed work.
CREATE TRIGGER runs_admission BEFORE INSERT OR UPDATE ON runs
FOR EACH ROW EXECUTE FUNCTION capture_workspace_run_admission();

CREATE FUNCTION fence_preexisting_workspace_runs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.runs SET "requiredReaderVersion" = GREATEST("requiredReaderVersion", 4)
    WHERE "spaceId" = NEW."spaceId";
  RETURN NEW;
END $$;
CREATE TRIGGER fence_preexisting_workspace_runs AFTER INSERT ON central_workspace_bindings
FOR EACH ROW EXECUTE FUNCTION fence_preexisting_workspace_runs();
