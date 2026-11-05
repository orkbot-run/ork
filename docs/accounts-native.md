<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->

# Native Ork Accounts connection

Register a public Accounts client for each native app, then supply its settings when
building Tauri or Expo:

```sh
ORK_ACCOUNTS_ISSUER=https://api.orkbot.run
ORK_ACCOUNTS_DESKTOP_CLIENT_ID=replace-with-desktop-public-client-id
ORK_ACCOUNTS_MOBILE_CLIENT_ID=replace-with-mobile-public-client-id
```

Client IDs are public. Use a separate ID for each app and keep client secrets out
of both binaries. If configuration is missing, requesting an Accounts connection
fails with a configuration error, while the rest of the app can still run locally
without a hosted Accounts service. Rebuild after changing these settings or URL
schemes.

## Provider registration

Both clients use authorization code flow, PKCE S256 and token endpoint authentication
method `none`. Register `authorization_code` and `refresh_token` grants and allow
`openid email profile offline_access`. Discovery lives at
`https://api.orkbot.run/.well-known/openid-configuration`. The issuer must match
exactly, including any trailing slash. Authorization, token, userinfo and JWKS
endpoints come from validated discovery, cached for five minutes.

Desktop reserves an ephemeral listener on `127.0.0.1` before opening the system
browser. Register `http://127.0.0.1/callback` with variable loopback ports allowed.
The host and `/callback` path must match. Mobile registers
`run.orkbot.app:/oauth2/callback`. Its scheme list also retains `orkbot` for existing
Better Auth callbacks. Expo Go cannot stand in for a binary with these schemes.

The production authorization endpoint sends users to the Accounts sign-in page,
where an existing browser session can be reused. Both clients check the callback
state and issuer. Before saving tokens, they verify the ID token signature,
issuer, audience, nonce and time claims, then check that userinfo belongs to the
verified subject.

## Credentials and sessions

Desktop exposes `window.orkbotDesktop.accounts.signIn()`, `.session()` and `.logout()`
through the trusted document bridge. Only identity metadata crosses that bridge.
Mobile exposes `continueWithAccounts()`, `accountsAccessToken()` and
`signOutAccounts()` from `lib/sso`. Desktop uses the operating system credential
store. Mobile uses SecureStore.

The selected Ork server owns a separate Better Auth session. Its existing Expo
authorization proxy and desktop SSO flow continue to provide that session.
Accounts access tokens stay separate from server session bearers. The API gains
no token exchange or bearer acceptance in this change.

With `offline_access`, the provider can return a refresh token. Both apps use it to
renew expiring access tokens and save the replacement credentials. A connection
without a refresh token needs another browser sign-in when access expires.

Refresh tokens rotate. After an ambiguous refresh failure, discard the local
credentials and sign in again because replaying the old token can trigger the
provider's reuse detection. Logout clears local credentials before trying
revocation, when discovery advertises it. The browser's Accounts session may
remain active if the provider has no end-session endpoint.

## Server-side SSO

For API-managed OIDC, use `OIDC_ISSUER=https://api.orkbot.run` together with the
operator's separately registered confidential client settings. See
[Self-hosted accounts](self-host-accounts.md#openid-connect-sso). Use separate
credentials for the API's confidential client.

## Verification

Check TypeScript, Rust and mobile tests before building. Offline coverage includes
discovery and redirect handling, callback state and issuer checks, ID token
verification, secure credential storage, refresh rotation and logout. Smoke-test
installed callbacks and keychain access on each platform. To test the full production
token flow, ask the operator to grant access to the installation first. Offline
tests do not cover that grant.
