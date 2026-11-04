# Integrations

Connection authorization, catalog search, plugin installation, and submission review live here, with ownership rules and records of approved catalog entries. Provider communication and plugin parsing stay behind workspace adapter interfaces.

`connectionsRoutes` builds connection RPC handlers and `pluginSubmissionRoutes` exposes submission HTTP handlers, while other domains use `installPlugin`, `setPluginParts`, `searchIntegrationCatalog`, and the named submission-review helpers. Model, memory, and MCP connections remain in their own modules.
