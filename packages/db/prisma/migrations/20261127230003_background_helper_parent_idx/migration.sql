-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

CREATE INDEX CONCURRENTLY "threads_parentThreadId_idx" ON threads("parentThreadId");
