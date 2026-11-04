# Ork

Ork starts from [Rakazo](https://github.com/elie222/rakazo), an open source assistant with persistent bots, shared conversations, and access to isolated computers. This fork keeps the web app, API, worker, Electron client, and Expo client together so we can develop our own product from that codebase.

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

## Fork boundary

The web app is named Ork. Internal packages still use `@rakazo/*`, and existing UI text, artwork, desktop/mobile identities, and provider configuration retain their upstream names. Native installers and published-image setup still belong to Rakazo and need their own Ork configuration before release. Use the source commands above for this checkout.

The original GitHub workflows now sit outside `.github/workflows/`, under `.github/upstream-workflows/`, so GitHub cannot run them automatically or through a manual dispatch while we configure Ork's releases. The active workflow runs verification only.

Keep `origin` pointed at the Ork repository and `upstream` at Rakazo:

```bash
git fetch upstream main
# Review upstream changes before merging them into your Ork branch.
git log --oneline HEAD..upstream/main
```

Until Ork has an `origin/main` branch, the development script uses `upstream/main` as its migration baseline. The initial import is commit `dbbc5fc7f35f548ef0477b0ac0fedb586788fb5a`.

## Checks and reference

```bash
corepack pnpm db:generate
corepack pnpm lint
corepack pnpm check
corepack pnpm test
corepack pnpm --filter @rakazo/web build
```

Production-backup tests use Linux tools such as `flock` and GNU `find`. Run that suite in a Linux environment with Bash 5.

[README.upstream.md](./README.upstream.md) contains the original setup and feature reference. The imported code retains its [Apache 2.0 license](./LICENSE) and attribution in [NOTICE](./NOTICE).
