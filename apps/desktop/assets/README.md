<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Rakazo contributors -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- Modified by Ork contributors for the Nunu desktop icons. -->
<!-- Inherited documentation remains Apache-2.0. New changes follow LICENSE.md. -->

# Desktop icons

The shared editable source and export notes are in
[`packages/ui-tokens/assets`](../../../packages/ui-tokens/assets/README.md).

Mac packaging requires Xcode 26 or newer. Electron builder compiles `Ork.icon`
into `Assets.car` for Tahoe and generates `icon.icns` for older macOS versions.
`icon-macos.png` is the Nunu development icon with Dock margins.

`icon.png` and `icon.ico` are matching mint Nunu exports for Linux and Windows.
Tauri generates its platform bundle icons from `icon.png` during preparation.
Refresh them with `pnpm --filter @orkbot/ui-tokens export:brand`.
