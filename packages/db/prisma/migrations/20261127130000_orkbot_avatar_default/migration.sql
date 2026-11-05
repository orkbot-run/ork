-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

-- Both avatar sets are understood by the previous release. Saved custom values stay untouched.
ALTER TABLE "user" ALTER COLUMN "botAvatarSet" SET DEFAULT 'orkbot';
ALTER TABLE "bots" ALTER COLUMN "avatarSet" SET DEFAULT 'orkbot';

UPDATE "user" SET "botAvatarSet" = 'orkbot' WHERE "botAvatarSet" = 'organic';
UPDATE "bots" SET "avatarSet" = 'orkbot'
WHERE "avatarSet" = 'organic' AND "avatarSetPinned" = false;
