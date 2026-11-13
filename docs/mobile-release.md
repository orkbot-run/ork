<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->

# Mobile builds and store releases

The `release-mobile` GitHub Actions workflow builds a signed iOS IPA with Xcode on a macOS runner. Expo supplies the SDK 57 native project through local prebuild. iOS builds require no Expo account, EAS project or Expo access token.

Default artifacts include the IPA and Android diagnostic APK. Upload to App Store Connect is a separate input. App Review remains manual.

## Configure iOS signing

Set these repository variables before requesting an iOS build:

| Variable | Value |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | The compatible product server's production HTTPS API origin. |
| `ORK_ACCOUNTS_MOBILE_CLIENT_ID` | The existing registered public Accounts mobile client. Preserve its callbacks. |
| `APPLE_TEAM_ID` | The Apple Developer team that owns the app and signing certificates. |
| `ORK_ACCOUNTS_ISSUER` | Optional override of the existing production Accounts issuer. The app validates that issuer. |

Use the product endpoint for `EXPO_PUBLIC_API_URL`. The central Accounts dashboard does not serve product API requests.

The workflow uses the existing `APPLE_API_KEY`, `APPLE_API_ISSUER` and `APPLE_API_PRIVATE_KEY` repository secrets to authenticate Xcode provisioning. Grant the key Certificates, Identifiers & Profiles access. Keep its `.p8` contents out of Git.

Import two dedicated iOS identities through these secrets:

| Secret | Value |
| --- | --- |
| `IOS_DEVELOPMENT_CERTIFICATE` | Base64-encoded P12 containing an Apple Development certificate and its private key. |
| `IOS_DEVELOPMENT_CERTIFICATE_PASSWORD` | That P12's password. |
| `IOS_DISTRIBUTION_CERTIFICATE` | Base64-encoded P12 containing an Apple Distribution certificate and its private key. |
| `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD` | That P12's password. |

Both identities must belong to `APPLE_TEAM_ID`. The desktop Developer ID certificate has a different purpose and fails the iOS identity check. Have the operator prepare both identities before running CI. Keep other developers' certificates intact.

Xcode archives with automatic signing using the development identity, then exports for App Store Connect using the distribution identity. `-allowProvisioningUpdates` and the three authentication-key flags let Xcode provision the app and its extensions. The app identifiers, app groups and notification capabilities must be available to that team. See [Apple's signing configuration](https://developer.apple.com/documentation/xcode/build-settings-reference) and [API-key authentication for Xcode distribution](https://developer.apple.com/videos/play/wwdc2021/10204/).

The runner imports both P12 files into one temporary keychain, checks their types and team, and removes each P12 after import. Build subprocesses receive public configuration without the signing secrets. Cleanup removes the API key and temporary keychain after success, failure or the workflow's cancellation cleanup step, while retaining unrelated keychains.

## Build an iOS artifact

Run from the accepted revision:

```sh
gh workflow run release-mobile.yml --ref main \
  -f build_ios=true -f submit_ios=false -f android_mode=diagnostic
```

The runner selects Xcode 27.2 from GitHub's `xcode-27` image, checks the Xcode 27.1 minimum, and uses Node 24 with the existing Rust transport build scripts. It installs dependencies, checks Expo package compatibility and TypeScript, runs release-control tests, performs `expo prebuild --platform ios --no-install`, and installs CocoaPods before archiving for a generic iOS device.

The build fails if the identity or transport pod is missing, native modules are absent from Expo's generated provider, or the compiled device transport library is unavailable. After export, it verifies the app signature, bundle ID, version, embedded JavaScript bundle, native module presence and matching extension versions. The exported app must use the dedicated distribution certificate.

The `ork-ios-<commit>-<attempt>` artifact contains `Ork.ipa`, a verification receipt and optional release notes. It excludes the signing directory and raw build logs. The receipt records the source commit, binary/package hashes and whether an upload was requested. Check that commit before distributing the IPA.

Choose `build_ios=false` and leave `submit_ios=false` for an Android-only run. The Android mode keeps its existing diagnostic and optional EAS paths.

## Upload to App Store Connect

Create or identify the App Store app that matches the mobile bundle identifier, then set the `ASC_APP_ID` repository secret to its numeric Apple ID. The build-only path needs no App Store app record.

Run `release-mobile` from `main` with `submit_ios=true` to build, verify and upload. Before uploading, the script reads that app record through the Apple API and requires an exact bundle-ID match. The same team API credential handles upload through Xcode. No separate Expo Submit credential is involved.

An upload does not submit the app for review. Review the processed build in App Store Connect, complete the store metadata and select the intended build before submitting it. The workflow's optional `notes` input is retained with the artifact for that operator step.

## Versions and updates

Native changes require a new binary. Bump `expo.version` in `apps/mobile/app.json` when native modules, config plugins, permissions or native dependencies change. The current runtime policy derives compatibility from that version. A JavaScript-only update cannot add the installation transport or device-key modules to an older app. See [Expo runtime versions](https://docs.expo.dev/eas-update/runtime-versions/).

GitHub builds use the workflow run number and attempt as the native build number. Each rerun gets a distinct value. The public app version comes from the tracked configuration, so the operator must choose a version compatible with the current store record before delivery.

OTA publishing remains optional and uses the separate EAS configuration described in [GitHub Actions configuration](./github-actions.md). Enable it only after compatible native builds exist. The CI classifier refuses OTA when native configuration, modules, dependencies or other native-sensitive inputs changed. EAS remote build-number settings in `eas.json` apply to its separate build path, not to the GitHub/Xcode iOS workflow.

## Android APK

The diagnostic mode builds with development signing on GitHub and retains an Actions artifact. It does not require an Expo account or publish a production release. Users can find published production packages on the [Ork download page](https://ork.run/download/).

The optional `eas` mode of `release-android-apk` retains its own Expo project and signing requirements. Configure `EXPO_TOKEN`, `EXPO_PROJECT_ID`, `EXPO_OWNER` and `EXPO_PUBLIC_API_URL`, and prepare the production EAS environment and managed Android keystore before choosing that mode. It publishes the rolling Android GitHub release. Google Play delivery uses a separate operator process.

For Android push notifications, register the app's Android package in Firebase, store `google-services.json` as an EAS file environment variable named `GOOGLE_SERVICES_JSON`, and configure the FCM V1 service account through EAS credentials. Keep those files outside Git. Firebase configuration requires a new native build. Builds without Firebase remain supported.
