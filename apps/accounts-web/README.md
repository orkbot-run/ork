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

Publish `dist/` under `/account/` on the dashboard origin. `Caddyfile` routes
`/account/api/auth/*` to `https://api.ork.run`, serves account pages/assets
from this build and forwards other requests to the existing dashboard.
`ACCOUNTS_UPSTREAM` can override the API destination for a different deployment.
The browser keeps relative requests and dashboard-scoped cookies; no frontend
API key, cross-origin cookie configuration or rebuild is needed to change upstreams.

Set these variables on the dashboard proxy (replace paths and service addresses):

```dotenv
DASHBOARD_HOST=dashboard.example.test
ACCOUNTS_WEB_ROOT=/srv/accounts
DASHBOARD_UPSTREAM=http://dashboard:5173
ACCOUNTS_UPSTREAM=https://api.ork.run
```

If EasyPanel terminates HTTPS in front of this Caddy container, use
`DASHBOARD_HOST=:80` and route the dashboard domain to port 80. Otherwise Caddy
serves the configured dashboard hostname directly. Do not route `api.ork.run`
back through this proxy: EasyPanel must route it directly to the Accounts service
on port 3200. This avoids a proxy loop.

On the private Accounts API, configure:

```dotenv
ACCOUNTS_URL=https://api.ork.run
ACCOUNTS_WEB_URL=https://dashboard.example.test/account
HOST=0.0.0.0
PORT=3200
NODE_ENV=production
```

Replace the dashboard example with the real UI origin, including `/account`.
On the Ork product API, set `OIDC_ISSUER=https://api.ork.run` and use the client
ID/secret registered with that Accounts deployment. Keep those credentials on the
server. For an existing installation, changing the issuer changes identity mappings;
do not silently migrate existing users by matching email addresses.

The Accounts domain serves API/discovery endpoints, not login pages. Discovery
advertises the dashboard API URLs, so `/account/api/auth/*` must reach Accounts
before any dashboard SPA fallback. Keep Origin and cookies intact; the proxy sets
the upstream Host for HTTPS routing. Trust only actual proxy peers in
`ACCOUNTS_TRUSTED_PROXY_IPS`, with the edge overwriting client IP headers.
Cloudflare or other edge access rules must allow OAuth discovery/token requests
and dashboard-to-API traffic without an interactive browser challenge.

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
