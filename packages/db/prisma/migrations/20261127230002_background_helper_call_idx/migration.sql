-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

CREATE UNIQUE INDEX CONCURRENTLY "threads_parentRunId_helperCallId_key" ON threads("parentRunId", "helperCallId");
