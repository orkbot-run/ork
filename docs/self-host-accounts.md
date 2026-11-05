<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- Inherited Apache-2.0 account configuration material is preserved in history. The Accounts-only guide follows LICENSE.md. -->

# Sign-in and accounts

The shipped Compose stacks use Ork Accounts as their only sign-in method. Registration,
email verification and password recovery belong to the Accounts service. The product
server creates its own session after verifying the central identity.

## Server configuration

Register a client for the installation and configure the API:

```env
OIDC_ISSUER=https://api.orkbot.run
OIDC_CLIENT_ID=replace-with-registered-client-id
OIDC_CLIENT_SECRET=replace-with-server-client-secret
OIDC_NAME=Ork Accounts
OIDC_SCOPES=openid email profile
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

A local server uses a registered public client, PKCE S256 and no client secret.
Set `OIDC_CLIENT_SECRET=` and `OIDC_REDIRECT_URI=http://127.0.0.1:5173/callback`
for source development. The development runner adjusts the port when needed.
The provider registration must allow variable loopback ports on that exact path.

"This computer" supplies these settings from the desktop build. See
[Native Ork Accounts](accounts-native.md#local-server-sign-in) for its build
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

## Existing installations

Switching to Accounts-only mode expires product sessions without verified OIDC
provenance and revokes their paired-device credentials. Users sign in again.
Their accounts, workspaces and files stay in place. Old passwords and passkeys
cannot restore access, even if their records remain in the database.

Sensitive operations require fresh Accounts reauthentication, bound to the current
user and session. A local password, emailed code or confirmation from an earlier
session cannot replace it. The operator account-bootstrap command is unavailable
in this mode.
