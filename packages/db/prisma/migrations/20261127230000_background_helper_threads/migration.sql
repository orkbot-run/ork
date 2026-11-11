-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

ALTER TABLE threads
  ADD COLUMN "parentThreadId" text,
  ADD COLUMN "parentRunId" text,
  ADD COLUMN "helperCallId" text;

ALTER TABLE threads ADD CONSTRAINT "threads_owner_with_helper_chk" CHECK (
  num_nonnulls("botId", "groupId", "externalConversationId", "parentThreadId") = 1
) NOT VALID;
ALTER TABLE threads DROP CONSTRAINT "threads_owner_chk";

ALTER TABLE threads
  ADD CONSTRAINT "threads_parentThreadId_fkey" FOREIGN KEY ("parentThreadId") REFERENCES threads(id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT "threads_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES runs(id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT "threads_helper_fields_check" CHECK (
    ("parentThreadId" IS NULL AND "parentRunId" IS NULL AND "helperCallId" IS NULL)
    OR
    ("parentThreadId" IS NOT NULL AND "parentRunId" IS NOT NULL AND "helperCallId" IS NOT NULL AND "botId" IS NULL AND "groupId" IS NULL AND "externalConversationId" IS NULL AND id <> "parentThreadId")
  ) NOT VALID;
