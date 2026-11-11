-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
CREATE INDEX CONCURRENTLY "messages_tool_work_idx" ON "messages" ("threadId", "seq") WHERE role = 'bot' AND jsonb_path_exists(blocks, '$[*] ? (@.kind == "steps")');
