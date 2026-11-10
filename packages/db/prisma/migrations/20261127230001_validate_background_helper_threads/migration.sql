-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

ALTER TABLE threads VALIDATE CONSTRAINT "threads_parentThreadId_fkey";
ALTER TABLE threads VALIDATE CONSTRAINT "threads_parentRunId_fkey";
ALTER TABLE threads VALIDATE CONSTRAINT "threads_helper_fields_check";
ALTER TABLE threads VALIDATE CONSTRAINT "threads_owner_with_helper_chk";
