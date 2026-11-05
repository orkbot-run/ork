<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Routines

Routine scheduling, test runs, announcements, and run history live here. The module prepares schedules and request data, then calls shared services for execution. Durable job processing stays in workspace packages, while thread delivery and model validation belong to their respective modules.

`routinesRoutes` builds RPC handlers. Use `assertRoutineSchedule`, `routineNextRunAt`, `createRoutineTestRun`, and `listRoutineRuns` from other domains when preparing a schedule or looking up execution history. `createRoutineAnnouncer` announces new routines and schedules their next wakeup.
