<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->

# Updates through your deployment panel

Keep Easypanel in charge of its Compose service. Ork can request a deployment through
that service's secret Deployment Trigger URL. The trigger must use HTTPS and have the
path `/api/deploy/<token>`. Keep it private.

Set the service's image channel in the panel before enabling requests from Ork.
`ORKBOT_IMAGE_TAG=edge` follows preview builds. Stable releases use `latest`, which
becomes available after the first stable release is published. The Compose template
keeps its existing `edge` default and accepts an explicit pinned tag. Choose the same
channel in the configuration below. `pull_policy: always` fetches the configured tag
when the panel deploys, including when you click Deploy directly in Easypanel.

Initialize the server first. On the deployment host, save this JSON in a private file
with mode `0600`, replacing the example trigger URL with the one for this Compose
service. Use a local editor so the token stays out of shell history.

```json
{
  "channel": "preview",
  "adapter": {
    "kind": "easypanel",
    "deploymentTrigger": "https://panel.example.test/api/deploy/replace-with-service-token"
  }
}
```

Run this from the deployment's Compose directory with the same project, files, and
environment arguments you normally use. Replace the volume placeholder with the
existing API configuration volume. The extra mount makes it writable for this
one-off command, while the running API keeps its read-only mount.

```bash
docker compose run --rm --no-deps -T --user 1000:1000 \
  --volume '<existing-api-configuration-volume>:/configure-updates:rw' \
  api node /app/infra/compose/selfhost-runtime.mjs \
  /run/orkbot/environment.json node --enable-source-maps \
  dist/cli/configure-server-updates.js \
  --delegate-current-owner --root /configure-updates < /private/path/updates-input.json
```

The command reads the initialized Accounts owner from the database and delegates
update requests to that identity. It prints neither the identity nor the trigger.
It writes a separate `updates.json`, owned by UID `1000` with mode `0600`, and preserves
the installation ID when you rotate the trigger. The channel and delegated identity
are fixed after activation. Changing either requires operator maintenance. Database passwords,
encryption keys, and `environment.json` stay unchanged. Redeploy the API after saving.

The delegated owner can request an update from Ork and enable its automatic policy.
Automatic requests start disabled. Ork offers a candidate only after the official
channel and full-commit image tags point to the same published image index.
It also verifies that the candidate descends from the running full-commit revision.
Unknown, older, or diverged revisions are withheld.

Automatic checks run every six hours, and each candidate gets one automatic attempt.
Requests have a one-hour cooldown. Older native sessions need a fresh Accounts
sign-in before they can use update controls, because the new permission check requires
proof attached to that session. Revoke delegation by removing `updates.json` from
the API configuration volume and restarting the API.

A successful trigger response means the panel accepted the request. Ork records the
request without claiming the deployment finished. A network error leaves an unknown
result because the panel may already have accepted it, so Ork never resends that
request after a restart. Check deployment output in Easypanel before trying again.

The trigger always deploys the panel's current configuration. Pin a known version in
the panel and redeploy there when you need to recover an earlier image. Database
migrations remain applied, so keep backups and check version compatibility first.
For a standalone Compose installation, use the existing private updater instead of
this panel trigger. Enable one deployment manager for each installation.
