<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Rakazo contributors -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- Modified by Ork contributors for the Nunu asset workflow. -->
<!-- Inherited documentation remains Apache-2.0. New changes follow LICENSE.md. -->

# App icon source

`Ork.icon` is the shared editable source for macOS and iOS. Open it in Apple's
Icon Composer with Xcode 26 or newer to edit the centered mint Nunu foreground
and system dark background. The transparent artwork is in `Assets/ork-nunu.png`.
Use `ork-nunu-monochrome.svg` for masks.

Tauri packaging generates ICNS, ICO and PNG bundle icons from the raster export.
Expo copies the editable Icon Composer source into the iOS project.

The platform exports are:

- `apps/desktop/assets/icon.png`: shared source for generated Tauri bundle icons.
- `apps/mobile/assets/icon.png`: opaque 1024-pixel square for the generic/legacy icon,
  with no rounded mask or Dock margins.
- `apps/mobile/assets/adaptive-icon.png`: transparent 1024-pixel Android foreground.
  The centered artwork leaves room for circular launcher masks.
- `apps/mobile/assets/icon-background.png`: opaque Android background using the
  shared dark background token.
- `apps/mobile/assets/monochrome-icon.png`: white Nunu silhouette with transparent
  eyes and smile for themed launchers.

Refresh exports after each source change. Android supplies its own mask.
Keep Mac corners, rims, and outer shadows out of the adaptive layers.

Run `pnpm --filter @orkbot/ui-tokens export:brand` to refresh platform raster
exports and the brand kit's icon and mascot: favicons, desktop icons, Android
layers, mobile splash, and notification icon. Square app icons use the shared
dark background. Browser marks use rounded corners, and the splash keeps transparent padding. Tauri derives
its bundle icons from `apps/desktop/assets/icon.png` during preparation.

Run `pnpm --filter @orkbot/www brand:render` to refresh the composite logo and
colored marketing avatars. These avatars use the shared `@orkbot/avatar` renderer.
Then run `pnpm exec tsx apps/www/scripts/render-og.mjs` to refresh social cards.
The card renderer uses the installed Playwright Chromium browser, with
`CHROME_PATH` as an optional executable override.

## Animated vector avatars

Web, Tauri, and mobile draw animated Nunu avatars from the shared
`logo-avatar-art.ts` geometry and paint definitions. The small ears, oval eyes,
and smile match the mascot. Existing bot colors and motion settings are preserved.
The vector renderers use gradients instead of loading the raster icon.
