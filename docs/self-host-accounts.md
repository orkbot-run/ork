<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- Inherited Apache-2.0 account configuration material is preserved in history. The Accounts-only guide follows LICENSE.md. -->

# Sign-in and accounts

The shipped Compose stacks use Ork Accounts as their only sign-in method. Registration,
email verification and password recovery belong to the Accounts service. The product
server creates its own session after verifying the central identity.

## Automatic server initialization

Start [`docker-compose.selfhost.yml`](../infra/compose/docker-compose.selfhost.yml)
with `PUBLIC_ORIGIN` set to the public HTTPS origin. Route that domain to `web:5173`.
The bootstrap job saves generated secrets in private configuration volumes.
Open the server's address in a browser.

Open the API container's console and issue a short-lived server setup code:

```sh
node /app/apps/api/dist/cli/server-claim.js
```

Choose either the personal Accounts link printed by the command or the workspace
dashboard's **Server** page. Check the full server address before approving. Wait for
the server to finish verification; approval alone does not mean it is connected.
For a server that already has an owner, use `--workspace` and approve with the same
owner account. The app pairing-key form is temporarily hidden on the server page.

The browser receives no product session. Accounts access tokens stay in the native app,
and the server receives a separate one-minute proof for its exact origin and random
challenge. No server OIDC client registration or client secret is required.

Workspace setup preserves the existing owner. Another account cannot claim an initialized
server, and matching email addresses never link accounts. Setup codes are short-lived and
can be used once. Older private initialization links remain supported for installations
that already use them.

## Disconnect a workspace server

An operator can disconnect a compatible server from its current workspace with:

```sh
node /app/apps/api/dist/cli/server-claim.js --disconnect-workspace
```

The command contacts Accounts before clearing the server's local connection. If Accounts
is unreachable, it reports an error and preserves the connection. A workspace admin can
also disconnect it from the dashboard. If the server is offline, it clears its local
connection after it can reach Accounts again. Existing users and server data are kept;
the operation does not revoke local sessions. Older connections may require the manual
`--clear-workspace <organization-id>` command after dashboard removal.

## Issuer change

The Accounts issuer is `https://api.ork.run`. Existing identity bindings from the previous issuer are not migrated. Back up any data you need, then create a new installation and sign in again.

## Earlier OIDC configuration

The [Linux server installer](self-host.md#linux-server-setup) registers its client using
a one-use code from the signed-in setup flow. The code is bound to the exact HTTPS origin
and expires after 15 minutes. Redemption returns the server's confidential client settings
and grants the owner access to that installation. Keep the returned client secret on the
server. An Accounts directory bookmark alone grants no installation access.

For an existing manually managed OIDC installation, register its client with an Accounts
operator and configure the API:

```env
OIDC_ISSUER=https://api.ork.run
OIDC_CLIENT_ID=replace-with-registered-client-id
OIDC_CLIENT_SECRET=replace-with-server-client-secret
OIDC_NAME="Ork Accounts"
OIDC_SCOPES="openid email profile"
AUTH_PASSWORD_ENABLED=false
OIDC_ALLOW_SIGNUP_BYPASS=false
```

Keep the client secret on the server. Its registered callback is
`https://server.example.com/api/auth/callback/oidc`, using the installation's exact
HTTPS origin. An Accounts operator must grant installation access before a user
can receive tokens for that client. Client registration alone grants no access.

The API checks the ID token signature, issuer, audience, nonce and subject before
creating a session. Account identity is bound to the issuer and subject. Matching
email addresses do not link accounts.

A missing issuer or client ID prevents startup. Discovery failures leave sign-in
unavailable while background retries continue. They never enable local passwords,
email codes or passkeys.

## Local desktop and development

The managed desktop server uses native Accounts proofs and verifies the account hash
before admitting a user. Each account gets its own database and Compose project.
Switching accounts preserves the previous instance. A saved server address never
transfers ownership of its data.

Source development can still use a registered public OIDC client and PKCE S256.
Set `OIDC_CLIENT_SECRET=` and `OIDC_REDIRECT_URI=http://127.0.0.1:5173/callback`
for source development. The development runner adjusts the port when needed.
The provider registration must allow variable loopback ports on that exact path.

See [Native Ork Accounts](accounts-native.md#local-server-sign-in) for the desktop build
configuration. Public client IDs are safe to distribute. No client secret belongs
in a desktop or mobile bundle.

## Installation policy

`SIGNUPS_ENABLED` and `SIGNUP_ALLOWLIST` still control whether a central identity
may create its first product workspace. Existing admitted accounts can sign in
when registration is closed. `OIDC_ALLOW_SIGNUP_BYPASS=true` bypasses the allowlist
only for identities accepted by the configured provider. It does not reopen
closed registration or mark an unverified email as verified.

The app-managed desktop server admits one account. Later sign-ins must identify
that same central account. Workspace ownership grants no server administration.
Automatic initialization admits the first owner even when ordinary registration is
closed. Later admissions still follow the server's local access policy.

## Existing installations

Switching to Accounts-only mode expires product sessions without verified OIDC
provenance and revokes their paired-device credentials. Users sign in again.
Their accounts, workspaces and files stay in place. Old passwords and passkeys
cannot restore access, even if their records remain in the database.

Sensitive operations require fresh Accounts reauthentication, bound to the current
user and session. A local password, emailed code or confirmation from an earlier
session cannot replace it. The operator account-bootstrap command is unavailable
in this mode.

Native login proofs establish a server session without a fresh reauthentication claim.
With native Accounts login, account deletion, full account export and revealing stored
secrets remain blocked until a separate fresh-confirmation protocol is available.
Signing in again cannot provide that confirmation.

## Personal device admissions

The server can retain a personal owner's device admission after verifying a signed Accounts login and proof of the device's P-256 private key. Offline session renewal uses a single-use challenge signed by that key and checks the exact installation, workspace, binding version and membership revision. Corporate access still expires within 300 seconds.

Revocation markers live under `DATA_DIR/identity/personal-revocations`. Preserve them with the database when backing up or restoring an installation, because they prevent a restored row from reviving a credential whose revocation was already received. Personal queued runs require reader version 5 and retain the device admission that authorized them when they were created.

Mobile builds with `OrkIdentity` store device keys in iOS Keychain or AndroidKeyStore. Renewal verifies an installation signature before signing the server's challenge. Logout deletes the keys and persists a denial marker. Restored personal admissions need a fresh Accounts verification. Desktop integration and the full iOS acceptance run remain release gates.
