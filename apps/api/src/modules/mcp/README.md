<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- Inherited Apache-2.0 guidance is preserved. Workspace process restrictions follow LICENSE.md. -->

# MCP

This module manages MCP servers, credentials, assignments, OAuth setup, and approval cards, checking endpoint and command policy before connections are used. Protocol clients and execution adapters stay in workspace packages.

`mcpRoutes` builds the RPC handlers and `createMcpServers` supplies server operations to agent imports, with approval helpers updating thread cards and queuing connected runs. `buildMcpUpdateMaterial` prepares credential changes, while `moveMcpArgsIntoSecrets` handles legacy stored arguments.

Accounts-enabled installations disable stdio MCP at startup in both the API and worker. This also covers enrollment in progress. Remote MCP connections remain available, and stored credentials stay on the server.
