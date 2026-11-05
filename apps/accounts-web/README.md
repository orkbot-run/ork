<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->

# Accounts frontend

The central account UI lives alongside the Ork dashboard and reuses its UI components
and semantic theme. It builds independently: customer installations do not serve it.
The private Accounts service owns credentials, verification, recovery, sessions and
OIDC. This package contains no server secrets, database access or authorization rules.

## Build and deploy

```sh
pnpm --filter @orkbot/accounts-web check
pnpm --filter @orkbot/accounts-web build
```

Publish `dist/` under `/account/` on the dashboard origin. `Caddyfile` shows the
split: `/account/api/auth/*` goes to the private Accounts API, account pages/assets
come from this build, and other requests go to the existing dashboard. Set
`DASHBOARD_HOST`, `ACCOUNTS_WEB_ROOT`, `DASHBOARD_UPSTREAM`, `ACCOUNTS_UPSTREAM`
and `ACCOUNTS_ISSUER_HOST` for your deployment.

Set the private API's `ACCOUNTS_WEB_URL` to `https://dashboard.example.test/account`.
Keep `ACCOUNTS_URL` (the identity issuer) unchanged for an existing deployment:
changing it would change issuer/subject identity mappings. Its host now serves
discovery/legacy API routes and redirects old account page links to the dashboard.
Discovery advertises the new dashboard API URLs. Central cookies use `/account`
and remain separate from the product's local session. Bind the API privately;
trust only the actual edge peer in `ACCOUNTS_TRUSTED_PROXY_IPS`.

The existing product dashboard continues initiating OIDC login. The signed login
continuation stays in the URL across account pages. The API validates it; the
frontend never decides which installation a user may access. No cross-origin
cookie sharing, browser client secret, external script, analytics or local-storage
session token is needed.

For a plain-HTTP loopback development session, start the private API with
`ACCOUNTS_URL=http://127.0.0.1:5174` and
`ACCOUNTS_WEB_URL=http://127.0.0.1:5174/account`, then run `pnpm --filter @orkbot/accounts-web dev`.
Open `/account/sign-in`. The Vite proxy forwards account requests to port 3200. Do not change a running
OIDC installation's issuer merely to preview the UI; use a separate development
instance or serve the build behind its existing HTTPS edge.

## Verification

The private Accounts repository owns the end-to-end contract suite. Build this UI
and supply its absolute `dist/` path as `ACCOUNTS_WEB_DIST` when running that suite.
It starts a real Bun API against a temporary PostgreSQL database and serves this
artifact through a same-origin edge. A loopback SMTP capture server receives test
verification/reset emails. The suite checks registration, verification, password
change/reset, session revocation and the existing OIDC continuation.

The public repository can build/typecheck this frontend without private backend
source or credentials. The private API's CI checks out this public package and runs the real browser
suite. Publish this frontend package first; pin `ACCOUNTS_WEB_REF` in the private
repository to the paired frontend commit when releasing. The public test harness
does not need a fake identity server or private repository credentials.
