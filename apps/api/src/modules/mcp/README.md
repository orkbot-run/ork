# MCP

This module manages MCP servers, credentials, assignments, OAuth setup, and approval cards, checking endpoint and command policy before connections are used. Protocol clients and execution adapters stay in workspace packages.

`mcpRoutes` builds the RPC handlers and `createMcpServers` supplies server operations to agent imports, with approval helpers updating thread cards and queuing connected runs. `buildMcpUpdateMaterial` prepares credential changes, while `moveMcpArgsIntoSecrets` handles legacy stored arguments.
