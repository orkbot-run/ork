<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Threads

This module resolves bot and group conversations, stores messages, tracks read state, and controls runs attached to a thread. It also handles image admission and message pagination. Agent execution, external delivery parsing, and computer control remain in their respective modules or workspace packages.

`threadsRoutes` builds RPC handlers, with services including `resolveThreadTarget`, `sendThreadMessage`, `threadSnapshot`, `stopThreadRuns`, and `markThreadRead`. `requireBotThread` and message-page helpers support other backend domains.
