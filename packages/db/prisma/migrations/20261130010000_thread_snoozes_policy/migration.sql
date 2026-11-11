-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

ALTER POLICY "thread_snoozes_system" ON "thread_snoozes"
  USING ((SELECT app_rls_bypass()));
