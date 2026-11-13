-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

-- Legacy account-wide sharing remains available in installations without central workspace mappings.
CREATE FUNCTION app_central_scope_is_managed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.central_workspace_bindings
    WHERE "spaceId" = NULLIF(current_setting('app.space_id', true), ''))
$$;

DO $$
DECLARE resource record;
BEGIN
  FOR resource IN SELECT table_name.relname FROM pg_class table_name
    JOIN pg_attribute column_name ON column_name.attrelid = table_name.oid
    WHERE table_name.relnamespace = 'public'::regnamespace AND table_name.relrowsecurity
      AND table_name.relkind = 'r' AND column_name.attname = 'spaceId' AND NOT column_name.attisdropped
  LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE USING ((SELECT public.app_rls_bypass()) OR NOT (SELECT public.app_central_scope_is_managed()) OR "spaceId" = NULLIF(current_setting(''app.space_id'', true), '''')) WITH CHECK ((SELECT public.app_rls_bypass()) OR NOT (SELECT public.app_central_scope_is_managed()) OR "spaceId" = NULLIF(current_setting(''app.space_id'', true), ''''))', resource.relname || '_central_resource', resource.relname);
  END LOOP;
END $$;
