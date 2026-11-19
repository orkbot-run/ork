<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- Inherited Apache-2.0 documentation is preserved. Lifecycle documentation is an Ork addition. -->

# Spaces

Space membership routes, item availability, and space deletion live here, with availability helpers choosing visible items and rehoming assignments when availability changes. Organization ownership and account deletion remain in `accounts`, which calls this module for space cleanup.

`spacesRoutes` and `availabilityRoutes` build RPC handlers, while other modules use `setAvailability`, `chooseForSpace`, and the related locking helpers. `deleteSpaceWithContent` coordinates content removal through injected storage and provider dependencies.

`startWorkspaceLifecycle` handles installation-authorized archive and deletion requests from Accounts. Archive keeps provider disks and waits for running work to stop. Deletion uses a durable receipt to resume cleanup after a restart, with later sweeps for interrupted uploads. Providers that cannot retain a complete disk or purge configured external memory leave the operation pending and report the reason to Accounts.
