-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

-- Old API processes still clear a parent while the new release comes online. The
-- generation changes in both versions, so they must also remove helper children.
CREATE FUNCTION clear_helper_threads_on_history_reset() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."historyCompactionGeneration" IS DISTINCT FROM OLD."historyCompactionGeneration" THEN
    DELETE FROM public.threads WHERE "parentThreadId" = NEW.id AND "spaceId" = NEW."spaceId";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER threads_clear_helper_children
AFTER UPDATE OF "historyCompactionGeneration" ON threads
FOR EACH ROW EXECUTE FUNCTION clear_helper_threads_on_history_reset();
