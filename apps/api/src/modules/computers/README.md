<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- Inherited Apache-2.0 guidance is preserved. Workspace host restrictions follow LICENSE.md. -->

# Computers

Computer routes coordinate files, screen access, control, and provider settings, along with local host configuration and retained-home cleanup. Sandbox implementations and device transport stay in workspace adapters. The `devices` module owns pairing.

Use `computerRoutes` and `computerProviderRoutes` for RPC, `mountScreenTarget` for screen access, and `mountLocalComputerHost` for local settings. `releaseComputerControl` and `homeRetentionSweep` expose cleanup operations for other domains and application lifecycle hooks.

Managed installations refuse host execution and host filesystem access. The API and worker pass the same fresh installation policy to sandbox routing and paired-device transport. Local settings can select Docker for cleanup while that policy denies host access.

Workspace computers use the versioned supervisor API. It checks existing containers for the exact home mount, disabled privilege escalation, and retained shared host mounts before content operations. Stop, release, and deletion remain available for cleanup. Providers without a verified workspace boundary are unavailable on Accounts-enabled installations.
