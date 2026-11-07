<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->

# Native Ork Accounts connection

The public website uses `ork.run`. Keep `https://api.orkbot.run` as the Accounts issuer because it is part of stored account identities and session proofs.

Register a public Accounts client for each native app, then supply its settings when
building Tauri or Expo:

```sh
ORK_ACCOUNTS_ISSUER=https://api.orkbot.run
ORK_ACCOUNTS_DESKTOP_CLIENT_ID=replace-with-desktop-public-client-id
ORK_ACCOUNTS_MOBILE_CLIENT_ID=replace-with-mobile-public-client-id
```

Client IDs are public. Use a separate ID for each app and keep client secrets out
of both binaries. If configuration is missing, requesting an Accounts connection
fails with a configuration error. Rebuild after changing these settings or URL schemes.

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

## Account and server selection

Desktop and mobile require a verified central Accounts session before opening the
product. Desktop signs in before it starts Docker or connects to an existing
server. To initialize a self-hosted server, generate a six-character pairing key in the app.
Enter it on the server's browser initialization page, choose **Initialize**, then approve
the full server address shown in the app. Accounts saves the server after ownership and
workspace creation complete. The waiting app refreshes the directory and connects using
its own server session. Mobile loads the same account directory.
An empty directory leaves the server picker open.

Remote entries follow the account. A Docker loopback entry belongs to the desktop
that created it, identified by a random local device ID, so another device never
opens that address as its own localhost. Removing a bookmark does not delete the
server or its data. Every selected server still verifies its own product session
and permissions.

The directory accepts central access tokens only at the fixed Accounts endpoint.
Native apps never send those tokens to saved servers. Switching central accounts
retires product sessions and pending operations before the next account opens.
Desktop also keeps each account and server in a separate browser profile.

## Server connection links

Opening a self-hosted server in a browser shows its address, a pairing-code field and an
**Open in Ork** link. Product screens and product login are available only in the native apps.
The browser still handles protocol callbacks, and Accounts can use the system
authorization browser to verify identity.

The link uses `orkbot://connect?server=<encoded-origin>`. Both apps validate the
address and retain it through Accounts sign-in. Ordinary connection links prefill the
pairing screen. The app generates a key without requiring a server address, then asks the
signed-in user to approve the immutable address claimed by the server. Only HTTPS and private-network HTTP origins are accepted. Paths,
credentials, fragments, and additional parameters are rejected. The link contains
no login token and grants no access; it can be shared without creating a session.

The selected server checks its own access policy. Failed or cancelled login does
not add it to the directory. Desktop verifies the session using native cookies;
mobile verifies the returned server session before saving the entry. A failed
desktop directory write offers a retry and retries when connectivity returns.
Device pairing is independent of saving the server.

Installed desktop builds register the `orkbot` scheme. Development registration
is platform-dependent; use the existing server address input when an unpackaged
build cannot receive links. Expo requires a development or release binary with
the configured schemes. The renderer Playwright fixture opens the native
renderer entry directly; ordinary browser tests use the connection page.

## Protocol compatibility

RPC requests from Tauri and Expo send `x-orkbot-protocol: 1` to the selected Ork server.
`/api/auth/capabilities` advertises the server's `protocol: { min, max }` range.
Missing ranges and client headers mean version 1. Malformed or incompatible ranges fail
validation, and the API rejects malformed headers with 400 and unsupported versions with 426.
Build-age checks remain separate. The optional `aiConsent` flag reports support for the
consent API, without granting or recording the user's consent.

## Local server sign-in

"This computer" uses Ork Accounts as its only sign-in method. The desktop build supplies
an account-bound login proof to its local API. The public client ID belongs to the
native Accounts connection. The local API needs no OIDC client settings.

Accounts verifies the identity. The local API verifies the login proof and creates a
product session for that identity. Passwords, email codes and passkeys on the local
server cannot sign in or confirm sensitive actions. Old product sessions without
verified OIDC provenance expire when the API starts in this mode, including their
paired-device credentials. Account and workspace data stay in place.

Set the repository variable `ORK_ACCOUNTS_DESKTOP_CLIENT_ID` for desktop builds
and `ORK_ACCOUNTS_MOBILE_CLIENT_ID` for mobile builds.
For a local build, export the same variable before compiling. A missing client ID
prevents native Accounts sign-in.

Each verified central account gets a separate Compose project, configuration directory
and database. Switching accounts keeps the other projects and their data in place.
An older shared local stack is reused only when its private `.desktop-owner` marker
has been bound to the verified issuer/subject hash by the operator. Saved picker choices
and directory bookmarks cannot establish that ownership.

## Credentials and sessions

Desktop exposes `window.orkbotDesktop.accounts.signIn()`, `.session()` and `.logout()`
through the trusted document bridge. Its server login method returns a short proof
bound to the selected server and challenge. The central bearer stays in native code.
Mobile exposes `continueWithAccounts()`, `accountsAccessToken()` and
`signOutAccounts()` from `lib/sso`. Desktop uses the operating system credential
store. Mobile uses SecureStore.

The selected Ork server owns a separate Better Auth session. Existing OIDC installations
still use the Expo authorization proxy or desktop SSO flow to create it.

New installations exchange native Accounts proofs for that session. The app obtains a
one-minute proof from the fixed Accounts endpoint and sends it to the selected server,
which checks the signature, exact audience and one-use challenge before issuing its own
session. The central bearer stays in the app.

With `offline_access`, the provider can return a refresh token. Both apps use it to
renew expiring access tokens and save the replacement credentials. A connection
without a refresh token needs another browser sign-in when access expires.

Refresh tokens rotate. After an ambiguous refresh failure, discard the local
credentials and sign in again because replaying the old token can trigger the
provider's reuse detection. Logout clears local credentials before trying
revocation, when discovery advertises it. The browser's Accounts session may
remain active if the provider has no end-session endpoint.

## Server-side SSO

New self-hosted stacks enable native Accounts proofs during automatic initialization.
Pairing keys expire after five minutes. Using a key claims one immutable server address.
The app must approve that address before Accounts issues a separate pairing-purpose proof
for the server's fresh challenge. The server initializes the owner without signing the
browser into the product, then reports success for the waiting native app.
Existing OIDC deployments keep their registered client configuration, and older private
initialization links remain supported.
See [Self-hosted accounts](self-host-accounts.md).

## Verification

Check TypeScript, Rust and mobile tests before building. Offline coverage includes
discovery and redirect handling, callback state and issuer checks, ID token
verification, secure credential storage, refresh rotation and logout. Smoke-test
installed callbacks and keychain access on each platform. A first-party app verifies
a central account before server selection. The selected installation checks its own
access policy when it creates the product session. Test both steps with a verified
central account. Offline tests do not replace that installed-app check.
