<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- Modified by Ork contributors for the licensing transition. See LICENSE.md. -->

# Ork

Ork is a source-available assistant for persistent bots that share conversations and work on isolated computers, with a web app, API, worker, Tauri client, and Expo client in one repository. Its public domain is `orkbot.run`. Use `orkbot` in package names and technical identifiers.

## Run locally

Install Node.js 22.22.2+ within the 22.x line, Node.js 24, or Node.js 26+, and start Docker. The repository pins pnpm 9.15.0 through Corepack.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm setup:local
corepack pnpm db:up
corepack pnpm dev
```

Open the development URL printed after migrations finish, which is usually `http://127.0.0.1:5173` unless another checkout already occupies one of the default ports. Create an account there. The interface and account setup do not require a hosted model key, so you can start locally and connect a model when you want to run a bot.

`setup:local` creates `.env` with random database passwords and independent encryption, authentication, supervisor, and screen-proxy secrets. Keep it private. Running setup again preserves the existing file. PostgreSQL uses the `ork` Compose project and a named volume, with its host port bound to loopback at `127.0.0.1:5433`.

To enable bots' Docker computers, build the local image once:

```bash
corepack pnpm sandbox:build
```

Stop development with Ctrl+C. `corepack pnpm db:stop` stops PostgreSQL and keeps its data. If port 5433 is occupied, change `POSTGRES_HOST_PORT` and both database URLs in `.env` before starting the database.

## Project identity

The product name is Ork. Workspace packages use `@orkbot/*`, configuration uses the `ORKBOT_` prefix, and the web and native clients use Ork identities. Published images, store listings, signing credentials, and hosted services require their own release configuration. Use the source commands above for local development.

GitHub Actions workflows are active under `.github/workflows/`. CI, test reports, image publishing, and diagnostic native builds use GitHub infrastructure. [GitHub Actions configuration](./docs/github-actions.md) lists the accounts and credentials needed for signed releases, store submissions, OTA, deployment, and optional integrations.

Keep `origin` pointed at `orkbot-run/ork` and `upstream` at the original source repository:

```bash
git fetch upstream main
# Review upstream changes before merging them into your Ork branch.
git log --oneline HEAD..upstream/main
```

Until Ork has an `origin/main` branch, the development script uses `upstream/main` as its migration baseline. The initial import is commit `dbbc5fc7f35f548ef0477b0ac0fedb586788fb5a`. Historical SQL migrations and cryptographic contexts keep their original identifiers so existing data remains readable.

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

Ork is based on [Rakazo](https://github.com/elie222/rakazo), Copyright 2026 Rakazo
contributors. Rakazo and the existing Apache baseline remain under
[Apache 2.0](./LICENSE). New Ork work is offered under
[PolyForm Noncommercial 1.0.0](./LICENSE-POLYFORM), with a paid commercial license
available by separate agreement. Ork modifications: Copyright 2026 Ork contributors.

Self-hosting is free for purposes permitted by PolyForm. Internal work for a
for-profit business requires a commercial license for the PolyForm-covered work
unless PolyForm expressly permits the use or applicable law allows it.
Earlier Apache grants remain valid. The combined product is source-available,
and its PolyForm parts are not OSI open source.

Read the [license map](./LICENSE.md), [attribution](./NOTICE), and
[FAQ](./docs/licensing-faq.md). Pricing is by individual quotation. The
[commercial agreement](./docs/commercial-license.md) and [CLA](./docs/cla/v1.md)
are drafts pending legal review and activation.
