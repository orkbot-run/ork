-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

ALTER TABLE runs ADD COLUMN "requiredReaderVersion" integer NOT NULL DEFAULT 0
  CHECK ("requiredReaderVersion" >= 0);

-- The database must enforce this because an older worker cannot check a new column.
-- This is a compatibility fence, not authorization; normal RLS remains in force.
CREATE FUNCTION guard_run_reader_protocol() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  parent_version integer;
  reader_text text;
  reader_version integer := 0;
BEGIN
  IF TG_OP = 'INSERT' OR NEW."retryOfRunId" IS DISTINCT FROM OLD."retryOfRunId" THEN
    IF NEW."retryOfRunId" IS NOT NULL THEN
      SELECT "requiredReaderVersion" INTO parent_version FROM public.runs
      WHERE id = NEW."retryOfRunId" AND "spaceId" = NEW."spaceId"
        AND "userId" = NEW."userId" AND "botId" = NEW."botId" AND "threadId" = NEW."threadId";
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Retry source is unavailable' USING ERRCODE = '23514';
      END IF;
      NEW."requiredReaderVersion" := GREATEST(NEW."requiredReaderVersion", parent_version);
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW."requiredReaderVersion" := GREATEST(OLD."requiredReaderVersion", NEW."requiredReaderVersion");
    -- Include expired leased->leased reclaims, but leave heartbeat/finalization alone.
    IF NEW.status IN ('leased', 'running') AND (
      OLD.status NOT IN ('leased', 'running') OR
      NEW."leaseOwner" IS DISTINCT FROM OLD."leaseOwner" OR
      NEW."leaseFence" IS DISTINCT FROM OLD."leaseFence"
    ) THEN
      reader_text := current_setting('app.run_reader_version', true);
      IF reader_text ~ '^[0-9]{1,9}$' THEN reader_version := reader_text::integer; END IF;
      IF NEW."requiredReaderVersion" > reader_version THEN RETURN NULL; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER runs_reader_protocol BEFORE INSERT OR UPDATE ON runs
FOR EACH ROW EXECUTE FUNCTION guard_run_reader_protocol();
