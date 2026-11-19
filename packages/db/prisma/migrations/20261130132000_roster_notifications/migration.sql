-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

-- A fixed-size invalidation is delivered only when the write commits.
CREATE FUNCTION public.orkbot_roster_signal(topic text, kind text)
RETURNS void LANGUAGE sql AS $$
  SELECT pg_catalog.pg_notify('orkbot_events', json_build_object('topic', topic, 'payload', kind)::text)
  WHERE topic IS NOT NULL;
$$;

CREATE FUNCTION public.orkbot_roster_owner_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.orkbot_roster_signal('roster:user:' || OLD."userId", TG_ARGV[0]);
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD."userId" IS DISTINCT FROM NEW."userId") THEN
    PERFORM public.orkbot_roster_signal('roster:user:' || NEW."userId", TG_ARGV[0]);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER roster_bot_change AFTER INSERT OR DELETE OR UPDATE OF
  "userId", "spaceId", name, description, instructions, color, "avatarSet", "avatarSeed",
  "replyMode", "notifyOnFinish", pinned, position, "sectionId", "archivedAt", "parentBotId",
  "computerId", "computerSwitching", "voiceId", "autoSpeak", "modelProvider", "modelId",
  "modelConnectionId", "thinkingLevel"
  ON public.bots
  FOR EACH ROW EXECUTE FUNCTION public.orkbot_roster_owner_change('roster');
CREATE TRIGGER roster_group_change AFTER INSERT OR DELETE OR UPDATE OF
  "userId", "spaceId", name, pinned, "sectionId", "archivedAt" ON public.chat_groups
  FOR EACH ROW EXECUTE FUNCTION public.orkbot_roster_owner_change('roster');
CREATE TRIGGER roster_section_change AFTER INSERT OR UPDATE OR DELETE ON public.bot_sections
  FOR EACH ROW EXECUTE FUNCTION public.orkbot_roster_owner_change('roster');
CREATE TRIGGER roster_space_member_change AFTER INSERT OR UPDATE OR DELETE ON public.space_members
  FOR EACH ROW EXECUTE FUNCTION public.orkbot_roster_owner_change('roster');
CREATE TRIGGER roster_member_change AFTER INSERT OR UPDATE OR DELETE ON public.member
  FOR EACH ROW EXECUTE FUNCTION public.orkbot_roster_owner_change('roster');
CREATE TRIGGER roster_snooze_change AFTER INSERT OR UPDATE OR DELETE ON public.thread_snoozes
  FOR EACH ROW EXECUTE FUNCTION public.orkbot_roster_owner_change('roster');
CREATE TRIGGER roster_external_conversation_change
  AFTER INSERT OR UPDATE OR DELETE ON public.external_conversations
  FOR EACH ROW EXECUTE FUNCTION public.orkbot_roster_owner_change('roster');

-- Do not publish a new signal for every streamed token or lease heartbeat.
CREATE TRIGGER roster_thread_activity
  AFTER UPDATE OF "nextMessageSeq", unread, "lastReadSeq" ON public.threads
  FOR EACH ROW WHEN (
    NEW."parentThreadId" IS NULL AND
    ROW(OLD."nextMessageSeq", OLD.unread, OLD."lastReadSeq")
      IS DISTINCT FROM ROW(NEW."nextMessageSeq", NEW.unread, NEW."lastReadSeq")
  )
  EXECUTE FUNCTION public.orkbot_roster_owner_change('activity');

CREATE FUNCTION public.orkbot_roster_run_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.orkbot_roster_signal('roster:user:' || t."userId", 'activity')
  FROM public.threads AS t
  WHERE t.id = NEW."threadId" AND t."parentThreadId" IS NULL;
  RETURN NULL;
END;
$$;

CREATE TRIGGER roster_run_started AFTER INSERT ON public.runs
  FOR EACH ROW EXECUTE FUNCTION public.orkbot_roster_run_change();
CREATE TRIGGER roster_run_status AFTER UPDATE OF status ON public.runs
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.orkbot_roster_run_change();

CREATE FUNCTION public.orkbot_roster_group_member_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.orkbot_roster_signal('roster:user:' || g."userId", 'roster')
  FROM public.chat_groups AS g
  WHERE g.id = CASE WHEN TG_OP = 'DELETE' THEN OLD."groupId" ELSE NEW."groupId" END;
  RETURN NULL;
END;
$$;

CREATE TRIGGER roster_group_member_change AFTER INSERT OR DELETE ON public.chat_group_members
  FOR EACH ROW EXECUTE FUNCTION public.orkbot_roster_group_member_change();

CREATE FUNCTION public.orkbot_roster_space_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.orkbot_roster_signal('roster:space:' || NEW.id, 'roster');
  PERFORM public.orkbot_roster_signal('roster:user:' || m."userId", 'roster')
  FROM public.space_members AS m WHERE m."spaceId" = NEW.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER roster_space_change AFTER UPDATE OF name, "isDefault", "deletingAt" ON public.spaces
  FOR EACH ROW WHEN (
    ROW(OLD.name, OLD."isDefault", OLD."deletingAt")
      IS DISTINCT FROM ROW(NEW.name, NEW."isDefault", NEW."deletingAt")
  )
  EXECUTE FUNCTION public.orkbot_roster_space_change();

CREATE FUNCTION public.orkbot_roster_organization_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.orkbot_roster_signal('roster:user:' || m."userId", 'roster')
  FROM public.member AS m WHERE m."organizationId" = NEW.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER roster_organization_change AFTER UPDATE OF name, slug, logo ON public.organization
  FOR EACH ROW WHEN (ROW(OLD.name, OLD.slug, OLD.logo) IS DISTINCT FROM ROW(NEW.name, NEW.slug, NEW.logo))
  EXECUTE FUNCTION public.orkbot_roster_organization_change();
