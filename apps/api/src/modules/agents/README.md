# Agents

This module imports agent definitions, manages their secrets and skills, and lists activity from saved runs. It also coordinates teaching sessions. Runtime execution stays in workspace packages, while bot membership and conversation routing belong to `bots` and `threads`.

Use `createAgentImportServices` to supply dependencies to import helpers, `createAgentSkillsService` and `createTaughtSkillsService` for skills, and `listSpaceRuns` for activity. Secret operations are exported from `agent-secrets.ts`.
