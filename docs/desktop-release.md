<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- Modified by Ork contributors for the Tauri desktop build workflow. See LICENSE.md. -->

# Desktop builds and releases

`desktop-tauri.yml` tests and builds Tauri for macOS Apple Silicon and Intel,
Windows x64 and Linux x64. Pull requests and main builds produce diagnostic installers.
Published stable and beta releases can produce signed updates.

## Stable and beta releases

Publishing a GitHub release with a tag such as `v1.2.3` starts the stable desktop
build. A published prerelease tagged `v1.3.0-beta.1` starts a beta build. Both use
the source tag as the updater version. Publication requires successful main CI for
the same commit and signed artifacts from all four platforms. If CI is still running,
rerun the desktop workflow after it passes.

The stable and beta manifests use `desktop-stable/latest.json` and
`desktop-beta/latest.json`. The beta channel also receives stable releases when they
are newer than its current version. Users can choose a channel in desktop settings. The
legacy Preview feed receives newer stable releases, so signed Preview installations can
receive the release if it uses their trusted signing key. Diagnostic builds have updates
disabled and need a new installer. Switching to Stable does not install an older version
over a newer beta.

Build locally with `pnpm --filter @orkbot/desktop build`. Keep signing credentials
outside the repository. The macOS screenshot workflow remains manual.

## macOS passkeys

Passkeys need an Apple signing certificate and a provisioning profile for
`run.orkbot.desktop.preview` with the Associated Domains capability. Use the build wrapper to validate that profile and apply its configuration to this build.

```sh
PASSKEY_PROFILE='<provisioning profile path>' \
APPLE_SIGNING_IDENTITY='<Apple signing identity>' \
ORKBOT_PASSKEY_RP_ID=app.example.com \
pnpm --filter @orkbot/desktop build --bundles app
```

The relying party defaults to `app.ork.run`. Configure the server's
`PASSKEY_APPLE_APP_IDS` to include `<TEAM_ID>.run.orkbot.desktop.preview` and serve its
association file through the web origin. Preserve any existing app identifiers.
Unsigned builds and invalid signing metadata hide macOS passkeys. Private development
domains also need `ORKBOT_PASSKEY_DEVELOPER_MODE=1` and associated-domain developer
mode on the test Mac. See [Self-hosted accounts](self-host-accounts.md#passkeys).

## Signing releases

Configure these Actions entries in the repository that owns the desktop releases:

| Type | Name | Value |
| --- | --- | --- |
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | Private Tauri updater key contents. |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for that key. |
| Variable | `TAURI_UPDATER_PUBLIC_KEY` | Matching public key contents. |

The release workflow builds signed artifacts for each published stable or beta tag.
It requires successful `ci.yml` for the release commit and all four native builds.
A failed platform leaves the existing channel in place. Pull requests never receive
the signing key or publish releases. Platform archive URLs stay tied to the release tag,
and an older release cannot replace a newer channel version.

## Installing and receiving updates

Install a signed release from GitHub Releases once. Older diagnostic builds have
updates disabled and need this initial replacement. The installed app checks after
30 seconds and then every hour, downloads a newer signed package in the background
and installs it after you choose Restart. It preserves the application identifier
and local account data. An empty feed is retried on the next scheduled check.

The app verifies signatures bound to the artifact version, accepts HTTPS only and
caps downloads at 256 MiB. The server frontend cannot choose the feed or signing key.
The app menu and Settings also provide manual update controls.

macOS releases require a Developer ID Application certificate and notarization, and
before any uploads the release job uses Apple's distribution tools to validate the
app bundle, the extracted updater archive and the DMG. Missing credentials stop
publication. The job also rejects invalid signatures and failed notarization.
Diagnostic builds stay off the public update channel and use an ad-hoc bundle signature.

Add these repository Actions secrets for macOS distribution:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12`, including its private key. |
| `APPLE_CERTIFICATE_PASSWORD` | The export password for that `.p12`. |
| `APPLE_SIGNING_IDENTITY` | Full Developer ID Application identity matching the certificate. |
| `APPLE_API_ISSUER` | Issuer UUID for an App Store Connect team API key. |
| `APPLE_API_KEY` | That API key's identifier. |
| `APPLE_API_PRIVATE_KEY` | Contents of its downloaded `.p8` private key. |

Keep the original private files outside the checkout. Enter the values in GitHub's
Actions secrets settings. Tauri imports the certificate into a temporary runner
keychain, and the workflow removes the temporary notarization key when the build ends.
The app needs no private signing keys or signing keychain access.

Updater signatures and Apple distribution signing are separate from Windows code
signing and macOS passkey provisioning. Before wider distribution, install the app
on each platform and test updating it from a previous build.

## Signing keys and local builds

Generate a signing pair on a trusted operator machine:

```sh
pnpm --filter @orkbot/desktop exec tauri signer generate --write-keys '<private-key-path>'
```

Back up the private key and password securely. A replacement key cannot update apps
that trust the original, so arrange rotation while the original key is available.
Never commit either secret. The public key may be stored in repository variables.

For a local build with updates, set these values at compile time and pass a local
configuration with `bundle.createUpdaterArtifacts` set to `true`:

```sh
ORKBOT_ENABLE_AUTO_UPDATE=1 \
TAURI_UPDATER_ENDPOINT=https://updates.example.com/latest.json \
TAURI_UPDATER_PUBLIC_KEY='<public key>' \
TAURI_SIGNING_PRIVATE_KEY='<private key contents>' \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<key password>' \
pnpm --filter @orkbot/desktop build --config '<release configuration path>'
```

Changing the environment of an already-built app does not change its update feed.
Local debug builds and default diagnostic builds keep updates disabled.
