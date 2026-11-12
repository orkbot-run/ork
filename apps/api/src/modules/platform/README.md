<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- Inherited Apache material is preserved. Workspace response authorization changes follow LICENSE.md. -->

# Platform

Environment loading, HTTP limits, health checks, monitoring, diagnostics, and shared RPC context live here. The module also provides request tracking, throttling, and transaction-retry helpers. Domain behavior belongs in its own module, and executable lifecycle wiring stays in `app.ts`, `index.ts`, and `cli/`.

`loadEnv`, `createRouter`, and `createRouterContext` are the main setup entrypoints, with middleware and helpers imported by name from their files. `app.ts` supplies the filesystem URL used by `readDeployedWebBuild`.

Centrally managed sessions carry the exact workspace ID and admission revision. `authorized-response.ts` holds the authorization watch for an authenticated response until its body closes, so a pending RPC read or file download is cancelled as soon as its workspace admission is revoked. Fanout events only invalidate access. Each API and worker verifies its own fresh central projection before restoring the affected workspace's authority window.
