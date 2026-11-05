<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->

# Tauri desktop development

`apps/desktop` uses Tauri 2. Its native WebView loads the selected Ork Server's web
frontend, and the bundle keeps the **Ork Preview** name and
`run.orkbot.desktop.preview` identifier so existing Tauri profiles remain usable.

## Run and check locally

Install the repository's Node and pnpm prerequisites, Rust through `rustup`, and the
native build dependencies for your platform. After `pnpm install`, run from the root:

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

The bundled setup page selects **Existing instance** or **This computer**. A server
switch waits for a candidate window to display a usable app before saving the new
choice and replacing the current window. Failed candidates leave the previous choice
and window intact.

Windows and Linux use separate WebView data directories for each complete server
origin, including its port. macOS 14 and later use a stable store per origin. Older
supported macOS versions use incognito WebViews, so login sessions end on exit or
reconnect. The selected address is still saved.

The native bridge belongs to the selected server's top-level document. Rust checks its
window, origin and private document proof before running a command, and checks again
before delivering events. Navigation cancels browser-auth and dictation.
Related SSO popups share the server's session without receiving native authority.
The setup page has separate capabilities, while remote pages receive no direct
filesystem or shell plugin permissions.

The selected frontend is trusted, including scripts it loads, so document proofs
cannot stop a successful XSS in that frontend from calling the permitted bridge actions.

**This computer** starts the shared Docker Compose stack through Rust. A private
ownership probe protects reuse of the managed project, and its server address stays
on loopback. Host computer access uses the native consent and revocation path backed
by the existing server-owned computer protocol. See [Desktop app](desktop-app.md) for
the account controls and permissions.

## Native capabilities

Native menus reuse the desktop translation catalogs. The bridge supports window
commands, badges where the platform supports them, browser OAuth, updater state and
macOS dictation through the bundled Swift helper. The helper is signed separately
before packaging. Native crash reporting is currently disabled.

Headless tests cover command authority, document isolation, local Docker lifecycle,
loopback OAuth, host access and mocked speech/update effects, leaving live SSO,
microphone recognition, notifications and installed updates for platform testing. Verify those flows on installed applications before a
production release.

See [Desktop releases](desktop-release.md) for signing, passkeys and update settings.
