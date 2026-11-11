-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

CREATE TABLE "workspace_model_policy" (
  "organizationId" text PRIMARY KEY REFERENCES "organization"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "modelId" text NOT NULL,
  "secretId" text NOT NULL,
  "secretRef" text NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL
);
ALTER TABLE "workspace_model_policy" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_model_policy_read ON "workspace_model_policy" FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM "spaces" s JOIN "member" m ON m."organizationId" = s."organizationId"
    WHERE s."id" = NULLIF(current_setting('app.space_id', true), '')
      AND s."organizationId" = "workspace_model_policy"."organizationId"
      AND m."userId" = NULLIF(current_setting('app.user_id', true), '')
  )
);
CREATE POLICY workspace_model_policy_owner ON "workspace_model_policy" FOR ALL USING (
  EXISTS (
    SELECT 1 FROM "spaces" s JOIN "member" m ON m."organizationId" = s."organizationId"
    WHERE s."id" = NULLIF(current_setting('app.space_id', true), '')
      AND s."organizationId" = "workspace_model_policy"."organizationId"
      AND m."userId" = NULLIF(current_setting('app.user_id', true), '')
      AND m."role" ~ '(^|,)\s*owner\s*(,|$)'
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM "spaces" s JOIN "member" m ON m."organizationId" = s."organizationId"
    WHERE s."id" = NULLIF(current_setting('app.space_id', true), '')
      AND s."organizationId" = "workspace_model_policy"."organizationId"
      AND m."userId" = NULLIF(current_setting('app.user_id', true), '')
      AND m."role" ~ '(^|,)\s*owner\s*(,|$)'
  )
);
CREATE POLICY workspace_model_policy_system ON "workspace_model_policy" USING ((SELECT app_rls_bypass()));
