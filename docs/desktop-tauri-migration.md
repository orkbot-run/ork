<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->

# Desktop migration to Tauri 2

`apps/desktop` now uses Tauri 2 for local development and packaging on all platforms.
The Electron runtime, dependency, packaging and release workflows have been removed.
Feature parity and platform verification remain in progress; the inventory below preserves
the historical Electron baseline and names files removed during this transition.

## Current target

**Ork** retains `run.orkbot.desktop.preview` for compatibility with existing Tauri profiles.
Legacy Electron application data is separate and is not imported automatically. Every launch
opens the setup page with the saved mode and address. Choose **Existing instance** and
**Connect**, or **This computer** and **Start server**. Server orchestration stays in Ork Server.

A server switch first opens a hidden candidate window and waits up to 20 seconds for the
shared `APP_DOCUMENT_STATE_SCRIPT` to recognize a usable app surface. Once ready, the app
saves the new choice and replaces the previous window, including when the web app has
mounted its error screen with a usable **Refresh** action. A candidate that fails readiness leaves the
previous window and saved server choice intact.

Windows and Linux select a separate WebView data directory using the SHA256 digest of the
full server origin, including its port. macOS 14 and later use a stable per-origin WebView
store identifier derived from that origin, whereas older supported versions use incognito
WebViews and lose login sessions on exit or reconnect. The saved address remains available.
On macOS, closing the active window hides it for 15 minutes, and reopening restores that window
or reconnects the saved server after it expires. Quit exits the application. Quick restore
and expiry/reconnect passed. Native expiry testing used a 10-second override, while the
default 15-minute interval was not observed in full. Windows and Linux exit when the
active server window closes.

The selected server's top-level page receives a bounded `orkbotDesktop` compatibility
bridge supporting native window actions, localized menu commands, badges, browser OAuth,
updater state and macOS dictation when the helper is available. Related SSO popups share
the selected server's WebView session and receive no native authority. Live SSO and OAuth
still need configured identity providers and integration accounts.

Native menus reuse the existing desktop translation catalogs for app commands, server
changes, local-server stop and update checks. Tauri exposes no menu roles for Paste and
Match Style, Delete or system text-to-speech. Those items are omitted. Native Undo and Redo
menu roles are available only on macOS, while other systems retain their WebView keyboard
editing behavior, which still needs runtime verification.

**This computer** runs Ork Server through Rust-managed Docker Compose using the repository's
shared Compose resources, with setup showing progress, retryable errors and logs under
**Technical details**. Saved secrets survive retries. A private token verifies ownership
of the separate Docker project before connecting, and managed server addresses stay
restricted to loopback. Electron data is not imported.

Bots cannot use this computer yet. The desktop needs a native transport with explicit
permission before connecting host control to Ork Server, which owns orchestration. No host
agent or Node runtime is bundled. The transport must preserve the existing consent and
revocation boundaries.

## Local development

Install the repository's Node and pnpm prerequisites, Rust through `rustup`, and the native
build dependencies listed in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
Run commands from the repository root after `pnpm install`.

```sh
pnpm --filter @orkbot/desktop dev
pnpm --filter @orkbot/desktop check:native
pnpm --filter @orkbot/desktop test:native
pnpm --filter @orkbot/desktop bundle
```

`dev` launches real windows, so keep routine automated verification headless on a
maintainer's computer and run interactive platform checks in a suitable test environment.
`bundle` packages the current host. Cross-platform support, notarization and working
updates still need installed-application checks.

## Parity inventory

Legacy source paths below refer to the removed Electron implementation under
`apps/desktop/src`, except where a full repository path is given. Tauri code is in `apps/desktop/src-tauri/src`. **Partial** marks implemented work
with remaining checks, and **Pending** covers missing implementation or evidence.

| Capability | Electron source and behavior to preserve | Tauri status and next verification |
| --- | --- | --- |
| Inventory | `main.ts`, `preload.cjs`, `setup-preload.cjs`, shared `packages/contracts/src/desktop.ts` | **Verified inventory** from source inspection only |
| Setup and Existing instance | `setup-config.ts`, `setup-store.ts`, `main.ts`: URL normalization, bounded health probe, saved choice, recovery | **Partial**: macOS setup, validation and failed-candidate rollback verified in the native app, other platforms pending |
| Shared React/Vite frontend | `main.ts`, `renderer-assets.ts`: server frontend, bundled asset overlay only for the managed local stack | **Partial**: actual macOS server frontend, login and onboarding verified, bundled renderer overlay and full workflow coverage pending |
| Account login and SSO | `main.ts`, `window-open.ts`, `apps/web/src/lib/sso-flow.ts`: named popups sharing the selected server's session, callback through BroadcastChannel | **Partial**: macOS password login and related-popup HttpOnly cookie sharing verified, popup native-bridge isolation checked in the WebView, live SSO pending |
| Integration/model OAuth | `browser-auth.ts`, `oauth-callback.ts`: system browser, validated one-use HTTP loopback callback, state checks and cancellation | **Partial**: Rust transport and bridge implemented, headless tests cover one-use delivery, rejected requests, expiry, port conflicts and cancellation, live provider flows pending |
| Session and storage isolation | `main.ts`, `setup-config.ts`: per-origin Chromium partitions plus legacy profile recovery | **Partial**: macOS 14+ persistence and cross-port isolation verified, Windows/Linux and older macOS runtime checks plus Electron data migration pending |
| Custom server headers | `server-request-headers.ts`: access-proxy headers limited to the selected origin, stripped on redirects | **Pending**: preserve same-origin requests without leaking headers to popups or other origins |
| Window lifecycle | `window-options.ts`, `second-instance.ts`, `main.ts`: native chrome, single instance, macOS warm window, quit/reopen behavior | **Partial**: macOS window state, quick warm restore and accelerated expiry/reconnect verified, full default interval and Windows/Linux lifecycle checks pending |
| Menus, shortcuts and locale | `main.ts`, `i18n.ts`, `locales/`: translated native menus and shared UI commands | **Partial**: generated catalogs and persisted locale implemented, Polish macOS menus and Cmd+K/settings callbacks verified, other accelerators/platforms and omitted native roles still need parity checks |
| Badges and notifications | `badge.ts`, `session-permissions.ts`, `apps/web/src/lib/browser-notifications.ts`, `apps/web/src/components/call/IncomingCall.tsx` | **Partial**: macOS badge set/clear verified, Linux implementation untested at runtime, Windows returns unsupported, Web Notifications, permission denial and background calls still need runtime checks |
| Tray and OS deep links | No tray, global shortcut registration, or custom OS URL scheme in the current Electron implementation | **Verified inventory**: no existing implementation to port |
| Local server through Docker | `local-stack.ts`, `docker-cli.ts`: private Compose configuration, image pinning, progress, retries, health/ownership checks and explicit stop | **Partial**: macOS start, stop, restart, owned-stack reuse and survival after desktop quit verified, Windows/Linux runtime checks pending |
| Local host access | `host-computer.ts`, `main.ts`: native consent, private capability, revocation and app-managed stack checks | **Pending**: agree the server/native boundary and port the transport with fail-closed consent |
| Remote host access | `user-device.ts`, `main.ts`, `packages/adapters/src/user-device-client.ts`: account-bound pairing and cancellation on revocation/sign-out | **Pending**: native transport, OS keyring storage and account/origin isolation tests |
| Screen control | `host-screen.ts`, `main.ts`: pinned drivers on macOS/Windows, checksum verification, OS consent and locked-screen refusal | **Pending**: preserve driver verification and permission attribution, retain explicit Linux limitations |
| System dictation | `system-speech.ts`, `apps/desktop/native/speech/main.swift`: macOS helper, session ownership, final result and cancellation | **Partial**: universal helper bundled as a macOS sidecar with verified ad-hoc signatures, process/protocol tests pass and invalid sessions are refused natively, real recognition, permissions and production signing pending |
| Passkeys | `passkeys.ts`, `main.ts`: associated domains, provisioning profile and system credential UI on macOS | **Pending**: bridge returns no native relying-party IDs, platform WebAuthn and native credential integration remain unverified |
| Error/crash reporting | `monitoring.ts`, `native-crashes.ts`: optional native reporting tied to server configuration and account changes | **Pending**: bridge reports native monitoring disabled, Electron-specific crash reporting still needs replacement and consent/configuration checks |
| Auto-update | `auto-update.ts`, `linux-update-signature.ts`: background check/download, progress, verified installation, retry and install-on-quit | **Partial**: state/check/download/install contract, verified cache, background checks and confirmation tested headlessly, disabled native actions return Unsupported, signed release feed, installed updates and install-on-quit pending |
| CI and native tests | `.github/workflows/ci.yml`, `.github/workflows/release-desktop.yml`, `.github/workflows/desktop-macos-screenshot.yml`, `apps/desktop/e2e/` | **Partial**: separate three-platform diagnostic workflow added, native macOS exercised locally, hosted builds and full cross-platform runtime checks pending |
| Size and RAM | `packages/testkit/src/cli/desktop-performance.ts`: removed harness launched Electron directly | **Partial**: current macOS app/DMG sizes and idle RSS recorded below, full-feature, multi-scenario and Windows/Linux acceptance pending |

## Native trust boundary

The selected server's frontend is trusted to use the exposed bridge, including scripts
it loads, same-origin frames and any successful XSS calling the parent's permitted native actions.
Private proofs protect direct IPC from foreign origins and stale documents. They provide
no protection against a compromised selected-server frontend.

The Tauri compatibility bridge grants one typed native command to a particular app window
and selected origin, with each document establishing a fresh identity through a private
window proof. Rust checks the live document before acting. Native event delivery checks that
identity again. Reloading, changing servers or closing a window invalidates its work and
cancels browser-auth and dictation sessions. Hidden candidates cannot start native work.
They can read initialization state.

Headless tests use Tauri's actual capability resolver to reject setup commands and direct
plugin calls from remote pages. Bridge tests also cover wrong origins, other windows and
stale documents. The bundled setup page keeps separate authority. Remote
pages receive no filesystem or shell plugin permissions, and popup windows receive no
native capability.

Related macOS popups replace the inherited WebKit user-script controller while retaining
the related configuration and session store, preventing the parent's privileged bootstrap
from being installed in the popup. Native checks confirmed both the missing
popup bridge and shared HttpOnly cookies, with parent commands still working after close.

Host control remains unimplemented in this target. Its transport must require native
consent, deny access when secure storage is unavailable and retain device credentials in
the native process.

macOS microphone usage declarations and the audio-input entitlement mirror the existing
desktop configuration, with the permission interaction still awaiting a runtime check.
The macOS configuration registers the speech helper as an `externalBin` sidecar, placing
it beside the main executable in `Contents/MacOS/orkbot-speech` so the bundler can sign
executables before the enclosing app. Staging uses a local ad-hoc signature, with production
certificate signing and notarization of the complete bundle still unverified. The universal
sidecar and complete application passed strict ad-hoc code-signature verification.

## Signing and update transition

Tauri updater signatures require their own key pair. The current Linux Ed25519 PEM update
key and Electron update manifests cannot be reused as a Tauri updater configuration.
See the [Tauri updater documentation](https://v2.tauri.app/plugin/updater/).

The preview reads updater settings at compile time through Rust's `option_env!`, using
`ORKBOT_ENABLE_AUTO_UPDATE=1`, `TAURI_UPDATER_ENDPOINT` for an HTTPS static manifest URL,
and `TAURI_UPDATER_PUBLIC_KEY` for the Tauri minisign public key.
Setting these variables only when launching an already-built app has no effect.
For a local configured build, use placeholders like these with your own values:

```sh
ORKBOT_ENABLE_AUTO_UPDATE=1 \
TAURI_UPDATER_ENDPOINT=https://updates.example.com/latest.json \
TAURI_UPDATER_PUBLIC_KEY='<Tauri minisign public key>' \
pnpm --filter @orkbot/desktop bundle
```

No endpoint or key is tracked. Configured, packaged release builds check after 30 seconds
and then every six hours. Available updates download within a 256 MiB limit. Only verified
bytes stay cached. The shared update bridge exposes state,
check, download and install actions, and **Check for Updates...** uses the same manager.
Installation requires native confirmation before restarting the app, with background
activity limited to checks and verified downloads.

Network requests and redirects require HTTPS. The updater requires a signature that binds
the artifact version, and neither the bridge nor remote page can choose its endpoint or
public key. Default builds and unpackaged runs report Unsupported. Neither sends updater
requests. Unsupported results stop automatic checks, while a manual check can retry after
its cooldown. Signed release publishing and install-on-quit remain pending.

`bundle.createUpdaterArtifacts` stays unset until the signed build and publishing path is
designed, so the diagnostic build does not produce the signed artifacts needed to exercise
an installed update. Manual signatures must pass `tauri signer sign --app-version <version>`
because `requireSignedVersion` is enabled. Tauri's build command binds the version when
producing updater signatures automatically.

Signed macOS builds still need an application signing certificate and notarization
credentials, and Windows needs a configured code-signing certificate or signing service.
Linux updater artifacts need Tauri signatures, and distribution packages need the signing
process required by their chosen channel. Credentials and accounts are unverified here.

Keep diagnostic build jobs usable without release secrets. Signed release jobs must fail
when required signing configuration is missing, verify the resulting signatures, and publish
only after every selected platform passes. Existing release safeguards remain in force.

An Electron installation cannot consume a Tauri update manifest through its current updater.
Plan a reviewed bridge release or an explicit installer migration, with rollback and version
ordering tested on installed applications. Retain the old application data until recovery
has been verified. Chromium profiles and encrypted device tokens require separate migration
decisions, including renewed login or consent where a safe import is unavailable.

## Local validation

The latest headless run passed **104 Rust tests** and **634 desktop TypeScript tests**,
with one skipped test, covering setup authority, the capability resolver,
document/session isolation, readiness deadlines, popup policy and Docker lifecycle logic.
Browser-auth tests exercise real loopback listeners with local requests. Dictation tests
use local helper processes, and updater tests use fake artifacts with no release network
or installer side effects. Twenty-two TypeScript tests cover the compatibility bridge.
Another Rust test executes the generated bootstrap and event JavaScript in a Node VM,
including a poisoned array iterator and navigation to a foreign origin. Desktop, web and
contracts TypeScript checks passed, along with the full `tauri:check`, including rustfmt
and Clippy. Source license headers, all 16 license tests and actionlint passed too.

A local HTML fixture exercised the macOS release WebView with isolated test data, checking
native bridge behavior separately from the real React server frontend.
Window-state queries and badge set/clear worked. Setting Polish changed the native menus,
and Cmd+K and Cmd+, delivered their expected callbacks. Disabled updater state, check,
download and install actions all returned Unsupported. Speech session zero was refused
without a microphone prompt, and an invalid HTTP OAuth URL was rejected.

Bad proofs, setup commands and direct updater-plugin IPC were denied in the native app.
Same-origin and cross-origin frames received no bridge of their own, with the same-origin
frame able to use its trusted parent's bridge as the trust model allows. Reload established a
working new bridge. A related popup had no full bridge and rejected wrong-proof IPC while
sharing its parent's HttpOnly session cookie. Closing it left parent commands working.

Warm reopen preserved the document. Expiry/reconnect also
worked with `ORKBOT_WARM_WINDOW_TTL_MS` shortened to 10 seconds for the check. The default
15-minute parser has a deterministic test. The final bundle and running process had no
TTL override, so the shipped configuration retains the default, without a full elapsed
15-minute observation.

Real macOS arm64 WebView testing used isolated local test data and a local PostgreSQL,
API and Vite stack. Password login reached onboarding. Quitting and restarting preserved
the session. A second server returned valid health JSON but an empty app, causing the
20-second readiness timeout while preserving the previous window, session and saved URL.
That server received no cookies from the first server's port.

Registry authorization failed with a retryable setup error. The successful path used the
repository's canonical application Dockerfile built locally, with cached computer and base
images. The release application started its own managed Docker stack. Supervisor, API,
worker and PostgreSQL became healthy,
initialization tasks exited successfully, and the web signup page appeared.
Saved setup retained mode `new` and the allocated loopback origin. The private ownership
probe succeeded.

Quitting Tauri left the same containers running and the server healthy, and relaunching
with the saved local mode reused them after the ownership check. **Stop Local
Server** stopped the project's running services. **Start server** restored the same existing
containers to healthy state and displayed signup again, preserving volumes, test data and
configuration. No bot or model workflow was tested.
Validation used isolated test data throughout, without connecting a hosted model or using
any production data. The final release connected to the owned stack and displayed the
real React signup page in Polish with its native server-change control. Quitting left
the server healthy.

Live identity-provider SSO, integration OAuth, real microphone recognition, notifications,
passkeys and host access remain untested. Windows/Linux runtime checks and production
signing credentials are also outstanding.

`NOTICE` and root licenses are bundled. Audit Rust dependency
licenses and expand bundled third-party notices before production distribution.

## Current local macOS comparison

The [current sanitized report](../apps/desktop/benchmarks/macos-arm64-native-integrations.json)
records packaged release clients at version 0.7.0 on macOS 27.0.1 arm64. They ran
concurrently. Both displayed the same managed server's Polish signup page with empty
fields. The measured preview includes the native bridge and universal speech sidecar.
The speech helper was stopped.

| Measurement | Tauri Preview | Electron | Observed reduction |
| --- | ---: | ---: | ---: |
| Uncompressed application bundle | 8.32 MiB | 493.60 MiB | 98.31% |
| Local diagnostic UDZO DMG | 4.93 MiB | 186.44 MiB | 97.35% |
| Median summed process RSS | 374.19 MiB | 527.73 MiB | 29.1% |

The Tauri application's logical file sizes total 8,727,174 bytes, and its DMG is
5,173,632 bytes. The DMG passed `hdiutil verify`, and app and helper signatures are ad-hoc.
Developer ID signing and notarization remain unverified.

Memory attribution used Apple resource coalitions through `proc_pidinfo`, including the
app's WebKit/XPC processes and Electron helpers. Backend/Docker processes and unrelated
applications were excluded. After 30 seconds of settling, six `ps` RSS samples at
three-second intervals covered nine Tauri processes and seven Electron processes.
Tauri ranged from 374.19 to 374.31 MiB, and Electron from 527.70 to 527.78 MiB.
No elevated privileges were needed.

Summed RSS counts shared pages in each process. It does not measure deduplicated physical
RAM, and no new physical-footprint snapshot was taken for this binary. These observations
cover one idle trial on one macOS architecture, with incomplete feature parity. Chat,
voice, long-running sessions and repeated launches remain unmeasured.

## Earlier pre-bridge macOS comparison

The [earlier report](../apps/desktop/benchmarks/macos-arm64-preview.json) archives a separate
snapshot from before the compatibility bridge, localized menus, dictation transport and
expanded updater. That preview lacked full feature parity.

The archive retains its own app/DMG sizes and RSS measurements alongside an error-free
and warning-free Apple `footprint` snapshot, which deduplicates multiply mapped objects
to report total dirty footprint. Footprint differs from summed RSS and unique resident
RAM. No new footprint snapshot was measured.

## Acceptance evidence still required

- [ ] Verify every parity row above on the applicable platforms.
- [ ] Build and run macOS, Windows and Linux applications through CI.
- [ ] Check rendering, login, media permissions, file interactions and keyboard behavior in each system WebView.
- [ ] Verify macOS signing/notarization and Windows code signing with configured release credentials.
- [ ] Install a signed Tauri update on each supported system, including signature rejection and recovery.
- [ ] Verify migration and rollback from an installed Electron release without losing server selection or user data.
- [ ] Repeat app and installer comparisons after feature parity using the normal release pipeline.
- [ ] Extend full-process memory measurements to chat, voice, long-running sessions and repeated launches on the supported platforms.

Attach platform, architecture, application version, scenario, repetitions and measurement
method to each benchmark result. Report raw measurements with the comparison.
