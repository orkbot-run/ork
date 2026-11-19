-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
-- Additive during the rollout: previous releases still read/write push_tokens.
-- A later release may remove the legacy Prisma model and add a migration whose
-- first line is -- deferred to drop push_tokens and mirror_legacy_push_registration().
BEGIN;
-- Prevent an older node from writing between the snapshot and trigger install.
LOCK TABLE "push_tokens" IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE "push_registrations" (
  "tokenDigest" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sessionId" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "presentation" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "push_registrations_userId_sessionId_key"
  ON "push_registrations"("userId", "sessionId");
ALTER TABLE "push_registrations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY push_registrations_system ON "push_registrations"
  USING ((SELECT app_rls_bypass()));

-- Encryption remains bound to push-token:<userId>, so no plaintext or key is
-- needed to carry the registrations from the preceding release.
INSERT INTO "push_registrations" ("tokenDigest", "userId", "sessionId", "ciphertext", "presentation", "updatedAt")
SELECT "tokenDigest", "userId", "sessionId", "ciphertext", "presentation", "updatedAt" FROM "push_tokens";

CREATE FUNCTION mirror_legacy_push_registration() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A late logout/receipt for the old token cannot remove a rotated token.
    DELETE FROM "push_registrations"
      WHERE "tokenDigest" = OLD."tokenDigest" AND "userId" = OLD."userId" AND "sessionId" = OLD."sessionId";
    RETURN OLD;
  END IF;
  -- Session deletion wins over an in-flight registration from an older node.
  IF NOT EXISTS (SELECT 1 FROM "session"
      WHERE id = NEW."sessionId" AND "userId" = NEW."userId" AND "expiresAt" > CURRENT_TIMESTAMP) THEN
    RETURN NEW;
  END IF;
  DELETE FROM "push_registrations"
    WHERE "userId" = NEW."userId" AND "sessionId" = NEW."sessionId"
      AND "tokenDigest" <> NEW."tokenDigest" AND "updatedAt" <= NEW."updatedAt";
  INSERT INTO "push_registrations" ("tokenDigest", "userId", "sessionId", "ciphertext", "presentation", "updatedAt")
    SELECT NEW."tokenDigest", NEW."userId", NEW."sessionId", NEW."ciphertext", NEW."presentation", NEW."updatedAt"
    WHERE NOT EXISTS (SELECT 1 FROM "push_registrations"
      WHERE "userId" = NEW."userId" AND "sessionId" = NEW."sessionId" AND "updatedAt" > NEW."updatedAt")
    ON CONFLICT ("tokenDigest") DO UPDATE SET
      "userId" = EXCLUDED."userId", "sessionId" = EXCLUDED."sessionId",
      "ciphertext" = EXCLUDED."ciphertext", "presentation" = EXCLUDED."presentation", "updatedAt" = EXCLUDED."updatedAt"
    WHERE "push_registrations"."updatedAt" <= EXCLUDED."updatedAt";
  RETURN NEW;
END
$$;
CREATE TRIGGER mirror_legacy_push_registration
AFTER INSERT OR UPDATE OR DELETE ON "push_tokens"
FOR EACH ROW EXECUTE FUNCTION mirror_legacy_push_registration();
COMMIT;
