-- deferred
-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

-- Keep the previous release's index until it has stopped using it.
DROP INDEX CONCURRENTLY IF EXISTS "messages_history_search_files_idx";
