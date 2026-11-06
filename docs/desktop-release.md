<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Rakazo contributors -->
<!-- Modified by Ork contributors for the Tauri desktop transition. -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->

# Desktop builds

Tauri 2 is the desktop runtime for Linux, macOS and Windows. Electron and its release
pipeline have been removed. The native application loads the selected Ork server.

Install Node/pnpm, Rust and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/),
then run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @orkbot/desktop check
pnpm --filter @orkbot/desktop test
pnpm --filter @orkbot/desktop test:native
pnpm --filter @orkbot/desktop check:native
pnpm --filter @orkbot/desktop bundle
```

`build` prepares the setup UI, icons and native bridge. `bundle` compiles Rust and creates
installers for the current host under `apps/desktop/src-tauri/target/release/bundle`.
`pack:dir` compiles without an installer. For a Linux Debian package only:

```sh
pnpm --filter @orkbot/desktop exec tauri build --bundles deb
```

Set `ORKBOT_WEB_URL` to a public HTTP(S) origin while building to change the initial server
address. Never put credentials in that URL. A saved server selection takes precedence.
This only selects the server; it does not bundle or deploy the API.

The `desktop-tauri.yml` workflow tests Rust and creates unsigned diagnostic installers
on GitHub-hosted Linux, macOS and Windows runners. Run it manually or download artifacts
from a matching main/PR run. It has read-only permissions and does not publish a release.

Signed distribution, notarization and a production updater feed still need Tauri-specific
configuration and installed-application verification. The updater is disabled by default;
its public key is empty in the tracked configuration. Legacy Electron signing keys and
update manifests do not configure Tauri. Do not enable automatic updates before configuring
and verifying the signed Tauri feed. See [migration status](./desktop-tauri-migration.md)
for remaining feature and platform checks.

The compatibility identifier `run.orkbot.desktop.preview` remains unchanged to preserve
existing Tauri profiles. Legacy Electron profiles are not imported automatically.
