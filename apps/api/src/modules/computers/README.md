<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Computers

Computer routes coordinate files, screen access, control, and provider settings, along with local host configuration and retained-home cleanup. Sandbox implementations and device transport stay in workspace adapters. The `devices` module owns pairing.

Use `computerRoutes` and `computerProviderRoutes` for RPC, `mountScreenTarget` for screen access, and `mountLocalComputerHost` for local settings. `releaseComputerControl` and `homeRetentionSweep` expose cleanup operations for other domains and application lifecycle hooks.
