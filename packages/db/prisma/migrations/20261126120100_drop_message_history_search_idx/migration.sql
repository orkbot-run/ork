-- deferred
-- SPDX-FileCopyrightText: 2026 Rakazo contributors
-- SPDX-License-Identifier: Apache-2.0

-- Sole statement so DROP INDEX CONCURRENTLY runs outside an implicit transaction.
-- messages_history_search_files_idx replaces it once the previous release stops searching.
DROP INDEX CONCURRENTLY IF EXISTS "messages_history_search_idx";
