-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

ALTER TABLE bots ADD COLUMN "replyMode" text NOT NULL DEFAULT 'chat'
  CHECK ("replyMode" IN ('chat', 'explicit'));
ALTER TABLE runs ADD COLUMN "replyMode" text NOT NULL DEFAULT 'chat'
  CHECK ("replyMode" IN ('chat', 'explicit'));

-- Plain scoped reads avoid adding bot/run row locks to producers' existing lock order.
-- SECURITY INVOKER retains the source actor's RLS, including on previous-release INSERTs.
CREATE FUNCTION pin_run_reply_mode() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  selected_mode text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW."replyMode" := OLD."replyMode";
  ELSIF NEW."retryOfRunId" IS NOT NULL THEN
    SELECT "replyMode" INTO selected_mode FROM public.runs
      WHERE id = NEW."retryOfRunId" AND "spaceId" = NEW."spaceId"
        AND "userId" = NEW."userId" AND "botId" = NEW."botId" AND "threadId" = NEW."threadId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Retry source is unavailable' USING ERRCODE = '23514';
    END IF;
    NEW."replyMode" := selected_mode;
  ELSE
    SELECT "replyMode" INTO selected_mode FROM public.bots
      WHERE id = NEW."botId" AND "spaceId" = NEW."spaceId" AND "userId" = NEW."userId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Bot is unavailable' USING ERRCODE = '23514';
    END IF;
    NEW."replyMode" := selected_mode;
  END IF;
  IF NEW."replyMode" = 'explicit' THEN
    NEW."requiredReaderVersion" := GREATEST(NEW."requiredReaderVersion", 2);
  END IF;
  RETURN NEW;
END;
$$;

-- An explicit row is already fenced at INSERT. UPDATE preserves its immutable pin,
-- so the earlier runs_reader_protocol claim guard always sees the required version.
CREATE TRIGGER runs_reply_mode_pin BEFORE INSERT OR UPDATE ON runs
FOR EACH ROW EXECUTE FUNCTION pin_run_reply_mode();
