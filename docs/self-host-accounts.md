<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- Inherited Apache-2.0 account configuration material is preserved in history. The Accounts-only guide follows LICENSE.md. -->

# Sign-in and accounts

Ork 1.4 separates the organization, server installation and workspace. Sign in through
Ork Accounts, choose a workspace in the desktop app, and connect to its server.
Accounts manages email verification, organization members and workspace access.
AI credentials stay on your server.

## New managed self-host installations

Start [`docker-compose.selfhost.yml`](../infra/compose/docker-compose.selfhost.yml)
with `PUBLIC_ORIGIN` set to the exact public HTTPS origin and a stable
`COMPOSE_PROJECT_NAME`. Route that origin to `web:5173`, including WebSocket traffic.
The bootstrap job creates private configuration volumes and the installation's
secrets. Keep those volumes.

The API and worker use restricted database credentials. The separate `migrate` job
loads its owner credentials from its own configuration volume. Keep migration credentials out of runtime services.

Open a shell in the running **API container**. Define this helper for that shell:

```sh
installation() {
  node /app/infra/compose/selfhost-runtime.mjs \
    /run/orkbot/environment.json \
    node /app/apps/api/dist/cli/installation.js "$@"
}
```

The wrapper reads the API's mounted runtime configuration without printing it.
Use this helper for the commands below. Supply the exact central organization or workspace ID.

Begin enrollment in the organization you selected in Accounts:

```sh
installation enroll --name "My server" --organization "<central-organization-id>"
```

Read the setup code, expiry and fingerprint. In
[Ork Accounts](https://app.ork.run), open that organization's **Servers** page, enter the
code under **Connect server**, and choose **Verify server**. Check the complete fingerprint before approval.

Complete the server's acknowledgement:

```sh
installation confirm
installation status
```

Wait for `confirm` to return `{"ready":true}`. A pending approval returns false,
so repeat `confirm` after approval or an interrupted acknowledgement. Keep using
the same installation and volumes during recovery. Approval alone is insufficient.

A personal organization has one owner, one server and one workspace. Create company workspaces under the connected server in Accounts. Clean
installations provision local workspace IDs and acknowledge them to Accounts.
Existing local data requires the explicit mapping described below.

For a remotely hosted server, publish its reachable HTTPS origin. Create a JSON file
inside the API container, for example `/tmp/ork-routes.json`, containing:

```json
[{"kind":"direct","address":"https://server.example.com","deviceId":null}]
```

Then publish it:

```sh
installation publish-routes --file /tmp/ork-routes.json
```

Use an origin without a path or credentials. Route publication replaces the entire list, including previously published routes. Managed remote desktop connections
check the installation's pinned identity and use TLS 1.3 over direct or relay routes.
Device-local routes remain scoped to their registered device.

## Workspace access and AI administration

An organization administrator can manage the registry without access to workspace
content. Add workspace members explicitly in Accounts. Administrators who need
content access must grant it to themselves through the same audited operation.

Configure AI through the connected app. A workspace administrator
can enable offered AI accounts, select permitted models and set the workspace
budget. Local operators delegate server-wide AI administration.
An organization role never supplies that delegation automatically.

After checking the authenticated account's exact account key and the installation
fingerprint, an operator can grant or remove it in the API console:

```sh
installation grant-ai-admin --account-key "<verified-account-key>" --fingerprint "<installation-fingerprint>"
installation revoke-ai-admin --account-key "<verified-account-key>" --fingerprint "<installation-fingerprint>"
```

Both values are 64-character hexadecimal identifiers. Verify the account key against
the central issuer and subject, rather than choosing an account by email or name.
The delegation is bound to the current installation binding and recorded in its audit
log. A server administrator must make an account available to the workspace before
the workspace administrator can enable it and choose a default model.

## Upgrade an existing installation

Upgrade the client and server before enabling the new workspace features. Older
clients require an update. Mobile binaries are released separately.

Back up the database together with the server data, private runtime configuration
and encryption keys. Preserve `DATA_DIR/identity/personal-revocations` as part of that
backup. Those markers prevent a restored database from reviving previously revoked
personal device admissions.

Keep the existing installation identity and ownership evidence. An installation
registered through the earlier server-claim flow needs an operator-qualified legacy
identity upgrade before V2 workspace mapping. The shipped installation CLI does not
perform that attestation. Arrange the upgrade with the Accounts operator, who must
verify the retained receipt and exact central server binding before changing local
state. Creating a replacement server registration is not a legacy upgrade.

Once the existing installation is bound and the target workspace exists in Accounts,
map it to the retained local IDs in the API console:

```sh
installation map-workspace \
  --workspace "<central-workspace-id>" \
  --local-organization "<existing-local-organization-id>" \
  --local-workspace "<existing-local-space-id>"
```

The command checks the local organization and Space relationship, persists the mapping
and acknowledges it to Accounts. Determine those IDs from the retained installation's
records. Names and matching emails never determine a mapping. Several local
organizations require an operator's explicit selection, and a conflicting mapping
stops the operation.

The production Accounts issuer is `https://api.ork.run`. An issuer change requires a
reviewed migration of identity bindings and ownership evidence. Retain the old data
while that migration is prepared.

Recovery must preserve the new authorization rules. Restoring an older image does not
reverse database migrations. Use a compatible image or forward fix, retain revocation
markers, and require fresh central verification after restoring personal admissions.

## Disconnect and reconnect

On the organization's Accounts **Servers** page, an authorized organization administrator can
choose **Disconnect server**. Disconnecting retains the installation's database,
files and volumes. Access is blocked when the server learns of the revoked binding.
Without central verification, company authorization expires within 300 seconds.

Reconnect only after Accounts has disconnected the old binding:

```sh
installation reconnect --name "My server" --organization "<central-organization-id>"
```

This command requires an authoritative refusal of the previous binding. A timeout or
Accounts outage cannot authorize recovery. It retains the installation key and data,
retires old local admissions and AI delegations, and issues a new approval code.
Complete fingerprint verification in Accounts, then run `installation confirm` again.
Recreate the required workspace access and AI assignments explicitly.

Legacy server-claim registrations may require the Accounts operator's existing
disconnect procedure before reconnection. Preserve their ownership receipts for that
operation. There is no `installation disconnect` command.

## Personal offline access

A previously activated personal device can continue local work without a fixed offline
time limit. Its retained authorization belongs to that device and installation.
Signing out removes the device key and retires its retained authorization. Reconnecting
to Accounts applies received revocations. Company authorization expires within 300 seconds.

The server verifies a single-use challenge signed by the device's P-256 key before
renewing an offline session. It checks the exact workspace, installation binding and
membership revision. Preserve revocation markers during backup and restore.

## Legacy OIDC registrations from 1.3 and earlier

Retain registered OIDC clients and grants during the upgrade. Earlier setup codes and private initialization links remain
subject to their original expiry, one-use and ownership checks. Preserve their exact callbacks.

For an already registered confidential server client, the retained configuration is:

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
`https://server.example.com/api/auth/callback/oidc`, using that installation's exact
HTTPS origin. Registration alone grants no access. The Accounts operator must grant
the installation's users access to that client.

OIDC verifies the issuer and subject alongside the signature, audience and nonce. Matching email
addresses never link accounts. Discovery failures leave sign-in unavailable and do
not enable local passwords or passkeys. Accounts-only mode expires product sessions
without verified OIDC provenance while retaining users, workspaces and files.

Source development can use a registered public OIDC client with PKCE S256. Set
`OIDC_CLIENT_SECRET=` and `OIDC_REDIRECT_URI=http://127.0.0.1:5173/callback` for the
development runner, whose registration must allow variable loopback ports on that
exact path. See [Native Ork Accounts](accounts-native.md#local-server-sign-in) for build
configuration. Public client IDs can be distributed, while client secrets stay on the server.

Sensitive account operations require fresh Accounts reauthentication tied to the
current user and session. Native login proofs do not provide that confirmation, so
full account export, account deletion and revealing stored secrets remain blocked
until a separate fresh-confirmation protocol is available.
