<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- Modified by Ork contributors to document licensing scope. Inherited material remains Apache-2.0. See LICENSE.md. -->

# Ork

Ork is a source-available assistant for persistent bots that share conversations and work on isolated computers. It runs in Tauri desktop and Expo mobile apps, backed by an API and worker. The web renderer runs inside Tauri. Its public domain is `ork.run`. Use `orkbot` in package names and technical identifiers.

## Run locally

Install Node.js 22.22.2+ within the 22.x line, Node.js 24, or Node.js 26+, and start Docker. The repository pins pnpm 9.15.0 through Corepack.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm setup:local
corepack pnpm db:up
corepack pnpm dev
```

Before starting the API, set the registered Accounts public client ID in `.env` as `OIDC_CLIENT_ID`. The local callback is `http://127.0.0.1/callback`, with the development port supplied at runtime. See [Accounts sign-in](docs/accounts-native.md#local-server-sign-in).

The development URL printed after migrations finish, usually `http://127.0.0.1:5173`, offers an **Open in Ork** link. It does not expose browser login or product screens. Open the link in an installed app, confirm the server, and sign in through Ork Accounts. The server is added to your account after its product session is verified. No model key is needed to open the app.

For desktop development, configure the registered native Accounts client as described in [Accounts sign-in](docs/accounts-native.md), then run `corepack pnpm --filter @orkbot/desktop dev`. Desktop development opens a native window.

`setup:local` creates `.env` with random database passwords and independent encryption, authentication, supervisor, and screen-proxy secrets. Keep it private. Running setup again preserves the existing file. PostgreSQL uses the `ork` Compose project and a named volume, with its host port bound to loopback at `127.0.0.1:5433`.

To enable bots' Docker computers, build the local image once:

```bash
corepack pnpm sandbox:build
```

Stop development with Ctrl+C. `corepack pnpm db:stop` stops PostgreSQL and keeps its data. If port 5433 is occupied, change `POSTGRES_HOST_PORT` and both database URLs in `.env` before starting the database.

## Project identity

The product name is Ork. Workspace packages use `@orkbot/*`, configuration uses the `ORKBOT_` prefix, and both native clients use Ork identities. Published images, store listings, signing credentials, and hosted services require their own release configuration. Use the source commands above for local development.

GitHub Actions workflows are active under `.github/workflows/`. CI, test reports, image publishing, and diagnostic native builds use GitHub infrastructure. [GitHub Actions configuration](./docs/github-actions.md) lists the accounts and credentials needed for signed releases, store submissions, OTA, deployment, and optional integrations.

## Checks and reference

```bash
corepack pnpm db:generate
corepack pnpm lint
corepack pnpm check
corepack pnpm test
corepack pnpm --filter @orkbot/web build
```

Production-backup tests use Linux tools such as `flock` and GNU `find`. Run that suite in a Linux environment with Bash 5.

[README.reference.md](./README.reference.md) contains the adapted setup and feature reference.

## License and attribution

New Ork work uses [PolyForm Noncommercial 1.0.0](./LICENSE-POLYFORM), with a
separate commercial license. Existing [Apache-2.0](./LICENSE) material keeps its
license. The combined product is source-available.

Self-hosting is free for purposes permitted by PolyForm. Internal work for a
for-profit business requires a commercial license for the PolyForm-covered work
unless PolyForm expressly permits the use or applicable law allows it.

Read the [license map](./LICENSE.md), [attribution](./NOTICE), and
[FAQ](./docs/licensing-faq.md). The commercial agreement sets monthly billing
per named user, across web, desktop, and mobile. Bots do not require
seats, and hosting is separate. The per-user price has not been set. The
[commercial agreement](./docs/commercial-license.md) and [CLA](./docs/cla/v1.md)
remain drafts pending legal review and activation. Subscriptions are not yet
available for purchase.

Copyright 2026 Ork contributors. Includes Apache-2.0 material, Copyright 2026
Rakazo contributors. See [NOTICE](./NOTICE) for provenance and required notices.
