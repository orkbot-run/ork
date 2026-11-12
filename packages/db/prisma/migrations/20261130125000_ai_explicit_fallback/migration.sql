-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

ALTER TABLE "workspace_ai_connections"
  ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "fallback" BOOLEAN NOT NULL DEFAULT false;

-- Preserve the frozen legacy choice without enrolling other accounts as fallbacks.
UPDATE "workspace_ai_connections"
SET "isDefault" = true
WHERE "connectionId" LIKE 'legacy:%' AND "enabled" AND "priority" = 0;

CREATE UNIQUE INDEX "workspace_ai_connections_one_default"
ON "workspace_ai_connections" ("spaceId", "bindingVersion")
WHERE "available" AND "enabled" AND "isDefault";

CREATE FUNCTION preserve_legacy_ai_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."connectionId" LIKE 'legacy:%' AND NEW.enabled THEN
    NEW."isDefault" := true;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_legacy_ai_default BEFORE INSERT ON workspace_ai_connections
FOR EACH ROW EXECUTE FUNCTION preserve_legacy_ai_default();
