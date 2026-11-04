# API

`src/app.ts` assembles the application. `src/index.ts` runs the server, and `src/cli/` contains executable maintenance commands. Domain code and its tests live under `src/modules/`.

| Module | Owns |
| --- | --- |
| `accounts` | Account lifecycle, identity checks, onboarding, and organization ownership |
| `agents` | Agent import, skills, secrets, and run activity |
| `bots` | Bot settings, removal, and team-chat coordination |
| `threads` | Conversations, messages, read state, and attached runs |
| `messaging` | Inbound deliveries, webhooks, receipts, and email selection |
| `mcp` | Server configuration, credentials, assignments, and approvals |
| `models` | Model connections, defaults, and pins |
| `computers` | Computer control, files, screens, configuration, and retained homes |
| `billing` | Plans, credits, referrals, wallet routes, and marketing preferences |
| `devices` | Device pairing, forwarding authorization, and session revocation |
| `voice` | Speech synthesis, transcription, credentials, and summaries |
| `security` | Audit records and exports, CSP reports, and secret migration |
| `content` | Artifacts, pages, boards, search, and shared rendering |
| `spaces` | Space membership, availability, and deletion |
| `routines` | Schedules, test runs, announcements, and history |
| `integrations` | Connections, plugin installation, and catalog review |
| `memory` | Memory settings, documents, scratchpad, and delegated skill routes |
| `platform` | Environment, HTTP utilities, shared RPC context, and diagnostics |

Each module's README names its exported entrypoints. Use relative `.js` imports inside a module and `#modules/<domain>/<file>` between modules. Shared product contracts and reusable behavior stay in workspace packages.

Tests are colocated. Scenario names describe the behavior they cover, so a test such as `thread-read.test.ts` can exercise several exports from `thread-target.ts`. Database suites use `*.postgres.test.ts`. Local test helpers use `*.test-support.ts`.

Run commands from the repository root after installing dependencies:

```sh
pnpm db:generate
pnpm --filter @orkbot/api check
pnpm --filter @orkbot/api test
pnpm --filter @orkbot/api test:postgres
pnpm --filter @orkbot/api build
pnpm lint
```

The Postgres command uses the shared integration harness and needs a running Docker engine. It creates a disposable database, applies migrations, and gives each suite an isolated database copy. Vitest enables its separate `postgres` project when the harness sets `VERIFY_DATABASE`.

Typechecking includes tests and keeps `jsx: react-jsx` because the auth workspace exports TSX email templates. API source files do not need JSX themselves. Formatting and linting use the monorepo's root `biome.json` and `scripts/biome` rules. Read [AGENTS.md](./AGENTS.md) before adding or moving API code.
