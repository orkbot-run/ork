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
Copy the initialization link from its logs and open it in Ork.

In Ork, sign in through Accounts and confirm the server address. The app then requests
a proof for that server and its random challenge. It expires after one minute. After
verifying the proof, the server creates a session and the app saves the server to your
account. No server OIDC client registration or client secret is required.

Keep the initialization link private. Claiming the first owner requires both that
secret and a verified Accounts identity. Once claimed, another identity cannot reuse
the secret to become an owner. The browser's ordinary connection page exposes no
bootstrap secret. Matching email addresses never link accounts.

## Earlier OIDC configuration

The [Linux server installer](self-host.md#linux-server-setup) registers its client using
a one-use code from the signed-in setup flow. The code is bound to the exact HTTPS origin
and expires after 15 minutes. Redemption returns the server's confidential client settings
and grants the owner access to that installation. Keep the returned client secret on the
server. An Accounts directory bookmark alone grants no installation access.

For an existing manually managed OIDC installation, register its client with an Accounts
operator and configure the API:

```env
OIDC_ISSUER=https://api.orkbot.run
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
