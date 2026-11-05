<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- Modified by Ork contributors for the Tauri desktop build workflow. See LICENSE.md. -->

# Desktop builds and releases

Find unsigned diagnostic Tauri installers in the Actions artifacts from
`desktop-tauri.yml`, which checks and builds the desktop client for macOS, Windows
and Linux. It publishes no releases or update feeds. The macOS screenshot workflow is
manual and captures the setup screen on its disposable runner.

Build locally with `pnpm --filter @orkbot/desktop build`, keeping signing credentials
outside the repository. Production signing and release publication remain unconfigured.

## macOS passkeys

Passkeys need an Apple signing certificate and a provisioning profile for
`run.orkbot.desktop.preview` with the Associated Domains capability. Use the build wrapper to validate that profile and apply its configuration to this build.

```sh
PASSKEY_PROFILE='<provisioning profile path>' \
APPLE_SIGNING_IDENTITY='<Apple signing identity>' \
ORKBOT_PASSKEY_RP_ID=app.example.com \
pnpm --filter @orkbot/desktop build --bundles app
```

The relying party defaults to `app.orkbot.run`. Configure the server's
`PASSKEY_APPLE_APP_IDS` to include `<TEAM_ID>.run.orkbot.desktop.preview` and serve its
association file through the web origin. Preserve any existing app identifiers.
Unsigned builds and invalid signing metadata hide macOS passkeys. Private development
domains also need `ORKBOT_PASSKEY_DEVELOPER_MODE=1` and associated-domain developer
mode on the test Mac. See [Self-hosted accounts](self-host-accounts.md#passkeys).

## Updates

Automatic updates are disabled in the default build. A configured Tauri build reads
these settings at compile time:

```sh
ORKBOT_ENABLE_AUTO_UPDATE=1 \
TAURI_UPDATER_ENDPOINT=https://updates.example.com/latest.json \
TAURI_UPDATER_PUBLIC_KEY='<Tauri minisign public key>' \
pnpm --filter @orkbot/desktop build
```

Changing the environment of an already-built app does not change its update feed.
The endpoint and redirects must use HTTPS. The updater verifies signatures bound to
the artifact version, caps downloads at 256 MiB and asks for native confirmation
before installation. The remote frontend cannot choose the feed or verification key.

Diagnostic builds leave `bundle.createUpdaterArtifacts` unset. A production release
must configure signed updater artifacts, publish a matching manifest and verify an
installed update on each supported platform. Manual signatures need
`tauri signer sign --app-version <version>` because `requireSignedVersion` is enabled.
Keep the private signing key outside the repository.

Release versioning still follows `.agents/skills/release/SKILL.md`. Tagging publishes
server images, while desktop installers currently remain diagnostic Actions artifacts.

## Updater signing procedure

Generate the signing pair on a trusted operator machine, saving the private key
outside the checkout. Enter its password at the prompt:

```sh
pnpm --filter @orkbot/desktop exec tauri signer generate --write-keys '<private-key-path>'
```

Back up the key securely. Keep it and its password in the release secret store,
and put the matching public key in `TAURI_UPDATER_PUBLIC_KEY`. Builds that trust a
lost private key cannot receive updates signed by a replacement, so plan the key
rotation while the original key is still available. Platform code signing uses
separate credentials.

For an authorized release, inject `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` through the build runner's secret environment.
Set the updater endpoint and public key shown above. Enable signed update output
with `{"bundle":{"createUpdaterArtifacts":true}}` in a local Tauri release
configuration, passed to the build with `--config`. Private keys, passwords and
signatures stay out of commits.

`tauri build` binds updater signatures to the application version automatically.
If signing an existing updater archive by hand, use the same version as the binary
and update manifest:

```sh
pnpm --filter @orkbot/desktop exec tauri signer sign \
  --private-key-path '<private-key-path>' \
  --app-version '<version>' '<updater-artifact-path>'
```

Publish each platform's artifact and generated `.sig` through the authorized
release process. Put the signature and HTTPS artifact URL in the matching platform
entry of the update manifest, then test an installed previous release on each
supported platform before promoting the feed. Diagnostic CI leaves these signing
and publication steps to the operator. See the
[Tauri updater guide](https://v2.tauri.app/plugin/updater/) for manifest fields.
