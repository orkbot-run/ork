<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- Ork changes move shared model administration into native server sessions. -->

# Models

AI accounts belong to this installation. The `serverAI` RPC serves the desktop and mobile settings screens through their selected server session. Accounts stores no AI credentials.

`ServerAICatalog` keeps encrypted secret references, account limits and workspace assignments, with separate IDs for accounts from the same provider. An assignment selects its allowed models, default, fallback priority and budget. Changing the workspace default takes one transaction.

Only a verified organization administrator may manage the organization's AI accounts. Account settings are scoped to that organization and applied across its workspaces on the installation. A workspace-only administrator cannot manage organization credentials. If no organization connection is enabled, users may use their own model connections; a configured but unavailable organization model does not silently fall back.

Run the installation CLI with the server's configured environment:

```sh
node apps/api/dist/cli/installation.js status
```

`installation.js enroll --name '<server-name>' --organization '<organization-id>'` starts enrollment, and `confirm` completes its acknowledgement. `installation.js publish-routes --file routes.json` replaces the advertised routes with a validated JSON array of `kind`, `address` and `deviceId` records. Use a canonical HTTPS origin for a direct route and `null` for its device ID. Existing local data requires an explicit `map-workspace --workspace '<central-workspace-id>' --local-organization '<local-organization-id>' --local-workspace '<local-space-id>'` operation.

Every provider attempt rechecks the workspace assignment and reserves capacity against the selected account. PostgreSQL coordinates budgets and account concurrency across workers. OAuth refresh locks follow the account ID. Quota responses observed by the HTTP adapters pause that account, and fallback can use only connections permitted by the assignment.

Installation OAuth sign-ins use a separate encrypted handoff namespace. Completion checks the original session, admission and installation binding, and reconnect refuses an account revision changed while the sign-in was open. Completion returns account metadata. The installation keeps provider tokens in its configured secret store.

The catalog migration preserves existing encrypted organization policies and local IDs. Once a workspace is centrally mapped, legacy personal model mutation and credential-probe endpoints reject its session. Workers must support run reader version 4 before these workspaces execute jobs. Unmapped local installations retain the existing model settings path.

Bots can select a specific assigned AI account, including when several accounts offer the same model. Execution rechecks that account and refuses a revoked assignment.
