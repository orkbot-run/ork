<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->

# Tauri desktop development

`apps/desktop` uses Tauri 2 and carries the React renderer in its application bundle.
The WebView keeps the selected server's origin for API requests and session cookies,
then starts the packaged renderer on the server's minimal HTML document. The bundle
is named **Ork**. It keeps the `run.orkbot.desktop.preview` identifier so existing
Tauri profiles remain usable.

## Run and check locally

Install the repository's Node and pnpm prerequisites, Rust through `rustup`, and the
native build dependencies for your platform. Desktop sign-in needs the Accounts build
settings used by CI. Export `ORK_ACCOUNTS_ISSUER` and the registered public
`ORK_ACCOUNTS_DESKTOP_CLIENT_ID` in your terminal before building. After `pnpm install`,
run from the root:

```sh
pnpm --filter @orkbot/desktop dev
pnpm --filter @orkbot/desktop check
pnpm --filter @orkbot/desktop test
pnpm --filter @orkbot/desktop tauri:test
pnpm --filter @orkbot/desktop build
```

The `tauri:dev`, `tauri:check` and `tauri:build` commands remain available. Development
opens real windows. Use the TypeScript and Rust checks for routine local verification, then build a
package for the current host platform without launching the app.

CI checks and builds Tauri on macOS, Windows and Linux in `desktop-tauri.yml`, while
`desktop-macos-screenshot.yml` captures the native setup screen on manual dispatch. Its full-screen artifact comes from a disposable GitHub runner.

## Server and session isolation

The bundled setup page selects an organization and workspace, or starts a local installation with **This computer**. A server
switch waits for a candidate window to display a usable app before saving the new
choice and replacing the current window. Failed candidates leave the previous choice
and window intact.

Windows and Linux use separate WebView data directories for each Accounts identity,
complete server origin and managed workspace target. macOS 14 and later use the same
stable scope. Older
supported macOS versions use incognito WebViews, so WebView cookies are cleared on
exit or reconnect. The selected address is still saved.

macOS stores account sessions and device credentials in the app's private data directory,
using mode `0700` for the directory and `0600` for credential files. The files are
unencrypted. OS user permissions control access, so software running as the same user
can read them. This storage avoids Keychain prompts. Sign in once after upgrading from
a build that used Keychain. Windows and Linux use their system credential stores.

The native bridge belongs to the selected server's top-level document. Rust checks its
window, origin and private document proof before running a command, and checks again
before delivering events. Navigation cancels browser-auth and dictation.
Related SSO popups share the server's session without receiving native authority.
The setup page has separate capabilities, while remote pages receive no direct
filesystem or shell plugin permissions.

The renderer and its stylesheet ship with the desktop app. Server deployments cannot
replace them. The selected server's document remains trusted, including scripts its
content policy permits, so an XSS in that document could call the permitted bridge
actions.

Desktop checks for the server's `nativeRenderer: "bundled-v1"` capability before
opening a product window. Upgrade an older server first. An older desktop connected
to the new server receives an **Update Ork** link instead of an empty product window.

**This computer** starts the shared Docker Compose stack through Rust. A private
ownership probe protects reuse of the managed project, and its server address stays
on loopback. Host computer access uses the native consent and revocation path backed
by the existing server-owned computer protocol. See [Desktop app](desktop-app.md) for
the account controls and permissions.

Choose the organization first. The installer checks its Docker installation's fingerprint against Accounts, then waits for both the server and workspace acknowledgements before opening Ork. Restarting setup reuses the installation key and workspace operation. Initial setup records an audited workspace admin assignment and delegates local AI administration to the signed-in account. Reopening a completed installation preserves subsequent access removals.

Local routes belong to one device. Setup keeps direct and tunnel routes when updating the Docker address, and other devices cannot select its loopback route. Disconnecting a server or changing its binding version requires operator recovery.

## Organizations and workspaces

Accounts supplies the version 2 organization, server and workspace catalog. Setup includes organizations without a server and shows workspaces that need provisioning or access. The account's default organization is shared across devices. Each desktop installation keeps its last workspace separately for each account and organization.

A workspace link names the organization, server and workspace IDs. Rust fetches the current catalog before opening that exact target, and login grants stay bound to its installation key and connection version. An unavailable target leaves the chooser open. Late link and directory results are discarded after an account switch.

## Native capabilities

Native menus reuse the desktop translation catalogs. The bridge supports window
commands, badges where the platform supports them, browser OAuth, updater state and
macOS dictation through the bundled Swift helper. The helper is signed separately
before packaging. Native crash reporting is currently disabled.

## Release qualification

Record each installed candidate separately. This matrix links the source and automated
checks, then lists the work still needed on an installed app. All candidate results
below are pending, including OS signing and updates from a previously installed version.

| Build target | Workflow runner | Installed candidate evidence |
| --- | --- | --- |
| macOS Apple Silicon | `macos-26` | Pending |
| macOS Intel | `macos-26-intel` | Pending |
| Windows x64 | `windows-2022` | Pending |
| Linux x64 | `ubuntu-24.04` | Pending |

[desktop-tauri.yml](../.github/workflows/desktop-tauri.yml) defines these build targets.
macOS has a configured minimum of 12.0, so testing an older supported release requires
an installed candidate on that OS as well as the build on the current runner.
Linux AppImage needs FUSE 2, and Linux ARM64 is outside this matrix.

**Implemented** means the code exists, and **Needs device qualification** marks a
feature whose installed behavior awaits a candidate-specific check on the intended
operating system. **Unsupported** identifies the limit and fallback. A **Missing**
row records a source gap until its correction is verified. Linked tests describe available coverage.

| Capability | Source status and evidence | Installed check / evidence |
| --- | --- | --- |
| Bundled renderer and server handoff | Implemented: [renderer script tests](../apps/desktop/src/renderer-script.test.ts). Requires server capability `nativeRenderer: "bundled-v1"`. | Pending: cold launch and old-client/server compatibility. |
| Accounts and saved server | Implemented: [Accounts](../apps/desktop/src-tauri/src/accounts.rs), [server login](../apps/desktop/src-tauri/src/server_login.rs). | Pending: restart restores login, default/single server selection, account/server switch, offline logout and pending revocation retry. |
| WebView and credential isolation | Implemented: [profile](../apps/desktop/src-tauri/src/profile.rs), [macOS private storage tests](../apps/desktop/src-tauri/src/credentials_macos.rs). Persistent WebView cookies are unsupported on macOS 12/13 and use incognito instead. | Pending: per-origin/account isolation and older-macOS reconnect behavior. |
| Browser OAuth/SSO and callbacks | Implemented: [browser auth](../apps/desktop/src-tauri/src/browser_auth.rs). | Pending: real configured callback, cancellation, expiration, replay and unrelated popup isolation. |
| Passkeys | Implemented with signing/association gating on macOS 13.3+: [passkey tests](../apps/desktop/src/passkeys.test.ts). | Pending: registration and sign-in with an installed signed app and its configured relying party. Preserve existing RP registrations. |
| Menus, shortcuts and windows | Implemented: [menus](../apps/desktop/src-tauri/src/menu.rs), [lifecycle](../apps/desktop/src-tauri/src/lifecycle.rs). | Pending: close/reopen, second launch, focus, text-input/IME shortcuts and external links. |
| Files and downloads | Needs device qualification: existing renderer/WebView paths. | Pending: choose/save/cancel, filenames and external opens on each WebView. |
| Local server lifecycle | Implemented: [local stack tests](../apps/desktop/src-tauri/src/local_stack.rs). | Pending: official images, start/reuse/stop and ownership checks. Quitting intentionally keeps the stack running. |
| Host computer access | Implemented: [host consent](../apps/desktop/src-tauri/src/host_computer.rs), [runner](../apps/desktop/src-tauri/src/host_runner.rs). | Pending: allow/deny/revoke during activity, account/server switch, logout and restart. |
| Dictation and calls | Implemented: [speech](../apps/desktop/src-tauri/src/speech.rs), [call tests](../apps/web/src/lib/call-session.test.ts). The bundled system recognizer is unsupported on Windows/Linux. Use available configured-provider/browser paths or report unavailable. | Pending: mic grant/deny/cancel, release, real audio and call speaker ownership. |
| Completed-run notifications | Implemented: [notification ownership tests](../apps/web/src/pages/shell/use-browser-notifications.test.tsx) cover active-chat clicks and retired handlers. | Pending: actual notification support, permission, click/focus and stale-event behavior in each installed WebView. |
| Full-screen pages | Implemented: [page view tests](../apps/web/src/components/pages/PageView.test.tsx) cover the macOS inset and matching page/backdrop exit timing. | Pending: traffic-light clearance, controls, focus restoration and close/reopen without backdrop flash. |
| Update download and installation | Implemented: [updater tests](../apps/desktop/src-tauri/src/updates.rs). Diagnostic/debug builds disable updates. | Pending: installed signed N-to-N+1 upgrade, tamper/wrong-key rejection, interrupted download/restart and preserved profile/local stack. |
| Distribution signing | Implemented: [release workflow](../.github/workflows/desktop-tauri.yml), [macOS distribution checks](../apps/desktop/scripts/macos-distribution.ts). Updater signatures and OS signatures are separate. Windows code-signing configuration is missing from this workflow. | Pending: macOS distribution signature/notarization and each installer's trust status. |

Native crash reporting is intentionally disabled, and desktop haptics are unsupported.
The [manual macOS screenshot workflow](../.github/workflows/desktop-macos-screenshot.yml)
captures the setup window of a diagnostic build on a disposable runner, with updates
disabled for that run. Authenticated screens and real microphone permissions still
need installed checks, along with passkeys and Windows/Linux behavior.

Use [Desktop releases](desktop-release.md) for signing and feed configuration.
A platform receipt needs the exact commit and version, artifact hash, installation
source and OS/WebView version, together with the outcome of each installed check and
a link to shareable evidence. Keep account identifiers, signing identities and
private service details in the operator's private records.
