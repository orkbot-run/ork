<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Memory

Memory documents, scratchpad items, provider settings, and skill RPC handlers live here, with ownership and endpoint-policy checks before configuration is saved. Skill services belong to `agents`, with connection preparation and memory storage supplied by workspace adapters.

`memoryRoutes` builds the RPC handlers. `persistMemoryProviderConfig`, `updateMemoryProviderDefaultScope`, and `disconnectMemoryProvider` update configuration, while `serializeSpaceMemoryConfig` returns the client representation. Dependencies are described by `MemoryProviderConfigDeps`.
