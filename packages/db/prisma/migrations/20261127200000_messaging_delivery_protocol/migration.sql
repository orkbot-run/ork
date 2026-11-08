-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

ALTER TABLE messaging_outbound ADD COLUMN "requiredDeliveryVersion" integer NOT NULL DEFAULT 0
  CHECK ("requiredDeliveryVersion" >= 0);
ALTER TABLE messaging_outbound ADD COLUMN "sourceBinding" text;

-- These are existing server-owned receipt keys, never a tool's free-form output.
CREATE FUNCTION is_system_delivery_key(delivery_key text, identity_id text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT delivery_key ~ '^(link:[^:]+|command:(leave|approve|decline|connected):[^:]+)$'
    OR (left(delivery_key, length('command:stop:' || identity_id || ':')) = 'command:stop:' || identity_id || ':'
      AND length(delivery_key) > length('command:stop:' || identity_id || ':'))
    OR (delivery_key ~ '^invite:[^:]+:[^:]+$' AND split_part(delivery_key, ':', 3) = identity_id);
$$;

CREATE FUNCTION direct_delivery_identity_binding(identity_id text, user_id text, space_id text, bot_id text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(identity_id, user_id, space_id, bot_id)::text, 'UTF8')), 'hex');
$$;

-- Cached legacy mirrors may outlive their source message or its authorization.
CREATE FUNCTION direct_delivery_source_allowed(identity_id text, source_id text) RETURNS boolean
LANGUAGE sql STABLE STRICT PARALLEL SAFE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.messaging_identities identity
      JOIN public.messages source ON source.id = source_id AND source."botId" = identity."botId"
      JOIN public.threads thread ON thread.id = source."threadId" AND thread."botId" = identity."botId"
        AND thread."spaceId" = identity."spaceId" AND thread."userId" = identity."userId"
      JOIN public.bots bot ON bot.id = identity."botId" AND bot."spaceId" = identity."spaceId"
        AND bot."userId" = identity."userId" AND bot."archivedAt" IS NULL
    WHERE identity.id = identity_id AND EXISTS (SELECT 1 FROM public.space_members membership
      WHERE membership."spaceId" = identity."spaceId" AND membership."userId" = identity."userId")
  );
$$;

-- Compatibility proof only; authorization remains in RLS and the scoped recovery operation.
-- Existing callers lock identity before row. Never acquire identity locks inside this trigger.
CREATE FUNCTION guard_direct_delivery_protocol() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  reader_text text;
  reader_version integer := 0;
  resolution text;
  failed_parent record;
  inherited_version integer;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.kind = 'dm' AND NEW."identityId" IS NOT NULL THEN
    -- Old producers also receive a trusted pin after migration; supplied values never establish it.
    NEW."sourceBinding" := NULL;
    IF NEW."sourceMessageId" IS NULL AND public.is_system_delivery_key(NEW."idempotencyKey", NEW."identityId") THEN
      SELECT public.direct_delivery_identity_binding(identity.id, identity."userId", identity."spaceId", identity."botId")
        INTO NEW."sourceBinding" FROM public.messaging_identities identity
        JOIN public.bots bot ON bot.id = identity."botId" AND bot."userId" = identity."userId"
          AND bot."spaceId" = identity."spaceId" AND bot."archivedAt" IS NULL
        WHERE identity.id = NEW."identityId" AND EXISTS (SELECT 1 FROM public.space_members membership
          WHERE membership."spaceId" = identity."spaceId" AND membership."userId" = identity."userId");
    END IF;
    IF NEW."sourceMessageId" IS NOT NULL THEN
      -- A legacy final mirror must not downgrade the tail of an already protected direct run.
      SELECT max(prior."requiredDeliveryVersion") INTO inherited_version
        FROM public.messages source JOIN public.runs run ON run.id = source."runId"
        JOIN public.messaging_identities identity ON identity.id = NEW."identityId"
        JOIN public.messages sibling ON sibling."runId" = run.id AND sibling."threadId" = run."threadId"
          AND sibling."botId" = run."botId"
        JOIN public.messaging_outbound prior ON prior."sourceMessageId" = sibling.id
          AND prior."identityId" = identity.id AND prior.kind = 'dm' AND prior."requiredDeliveryVersion" > 0
        WHERE source.id = NEW."sourceMessageId" AND source."threadId" = run."threadId"
          AND source."botId" = run."botId" AND run."userId" = identity."userId";
      NEW."requiredDeliveryVersion" := GREATEST(NEW."requiredDeliveryVersion", COALESCE(inherited_version, 0));
    END IF;
  END IF;
  -- An old file callback may ignore a refused status update and still insert its notice.
  -- Only a known failed parent authorizes that notice; inherit its sender requirement.
  IF TG_OP = 'INSERT' AND NEW.kind = 'dm' AND NEW."identityId" IS NOT NULL
    AND right(NEW."idempotencyKey", 7) = ':notice' THEN
    SELECT parent.status, parent."providerHandle", parent."requiredDeliveryVersion" INTO failed_parent
      FROM public.messaging_outbound parent
      WHERE parent."idempotencyKey" = left(NEW."idempotencyKey", -7)
        AND parent."identityId" = NEW."identityId" AND parent.kind = 'dm'
        AND parent."requiredDeliveryVersion" > 0;
    IF FOUND THEN
      IF failed_parent.status <> 'failed' OR failed_parent."providerHandle" IS NOT NULL THEN RETURN NULL; END IF;
      NEW."requiredDeliveryVersion" := GREATEST(NEW."requiredDeliveryVersion", failed_parent."requiredDeliveryVersion");
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW."sourceBinding" := OLD."sourceBinding";
    NEW."requiredDeliveryVersion" := GREATEST(OLD."requiredDeliveryVersion", NEW."requiredDeliveryVersion");
    IF OLD."requiredDeliveryVersion" > 0 THEN
      IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW."identityId" IS DISTINCT FROM OLD."identityId"
        OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW.body IS DISTINCT FROM OLD.body
        OR NEW."sourceMessageId" IS DISTINCT FROM OLD."sourceMessageId" THEN
        RAISE EXCEPTION 'Protected delivery cannot be rebound' USING ERRCODE = '23514';
      END IF;
      IF OLD.status IN ('uncertain', 'resolved_sent', 'resolved_not_sent', 'retired') AND NEW.status IS DISTINCT FROM OLD.status THEN
        resolution := current_setting('app.messaging_delivery_resolution', true);
        IF NOT COALESCE((OLD.status = 'uncertain' AND
          ((NEW.status = 'resolved_sent' AND resolution = 'confirmed_sent') OR
           (NEW.status = 'resolved_not_sent' AND resolution = 'confirmed_not_sent') OR
           (NEW.status = 'retired' AND resolution = 'source_unavailable'))), false) THEN
          RETURN NULL;
        END IF;
      END IF;
      IF OLD.status = 'sent' AND NEW.status IN ('pending', 'failed') THEN
        IF NEW.status = 'pending' AND OLD."providerHandle" IS NOT NULL THEN RETURN NULL; END IF;
        IF OLD."providerHandle" IS NULL AND current_setting('app.messaging_delivery_outcome', true) IS DISTINCT FROM 'rejected' THEN
          NEW.status := 'uncertain';
          NEW."nextAttemptAt" := NULL;
        END IF;
      END IF;
    END IF;
  END IF;
  IF NEW.kind = 'dm' AND NEW."identityId" IS NOT NULL AND NEW.status = 'sent'
    AND (TG_OP = 'INSERT' OR OLD.status = 'pending') THEN
    IF NEW."sourceMessageId" IS NOT NULL AND NOT public.direct_delivery_source_allowed(NEW."identityId", NEW."sourceMessageId") THEN
      RETURN NULL;
    END IF;
    IF NEW."sourceMessageId" IS NULL AND public.is_system_delivery_key(NEW."idempotencyKey", NEW."identityId")
      AND NOT EXISTS (SELECT 1 FROM public.messaging_identities identity
        JOIN public.bots bot ON bot.id = identity."botId" AND bot."spaceId" = identity."spaceId"
          AND bot."userId" = identity."userId" AND bot."archivedAt" IS NULL
        WHERE identity.id = NEW."identityId" AND NEW."sourceBinding" =
          public.direct_delivery_identity_binding(identity.id, identity."userId", identity."spaceId", identity."botId")
          AND EXISTS (SELECT 1 FROM public.space_members membership
            WHERE membership."spaceId" = identity."spaceId" AND membership."userId" = identity."userId")) THEN
      RETURN NULL;
    END IF;
    IF NEW."requiredDeliveryVersion" > 0 THEN
      reader_text := current_setting('app.messaging_delivery_version', true);
      IF reader_text ~ '^[0-9]{1,9}$' THEN reader_version := reader_text::integer; END IF;
      IF NEW."requiredDeliveryVersion" > reader_version THEN RETURN NULL; END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM public.messaging_outbound earlier
      WHERE earlier."identityId" = NEW."identityId" AND earlier.id <> NEW.id
        AND earlier."requiredDeliveryVersion" > 0
        AND (earlier.status = 'uncertain' OR (earlier.status = 'sent' AND earlier."providerHandle" IS NULL))) THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER messaging_outbound_delivery_protocol BEFORE INSERT OR UPDATE ON messaging_outbound
FOR EACH ROW EXECUTE FUNCTION guard_direct_delivery_protocol();
