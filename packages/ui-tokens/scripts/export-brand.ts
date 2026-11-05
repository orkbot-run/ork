// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to export the Nunu artwork across all platforms.
// Inherited export infrastructure remains Apache-2.0. New changes follow LICENSE.md.

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { darkTokens } from "../src/index.ts";

const root = new URL("../../../", import.meta.url);
const path = (name: string) => fileURLToPath(new URL(name, root));
const source = path("packages/ui-tokens/assets/Ork.icon/Assets/ork-nunu.png");
const assetLicense =
  "SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0\nSPDX-FileCopyrightText: 2026 Ork contributors\n";

// Keep the same centered foreground in Icon Composer and the square exports.
const portrait = await sharp(source).resize(1024, 1024).png().toBuffer();
async function framed(background: string) {
  return sharp({ create: { width: 1024, height: 1024, channels: 4, background } })
    .composite([{ input: portrait, top: 0, left: 0 }])
    .png()
    .toBuffer();
}
const mask = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" rx="200" fill="white"/></svg>',
);
async function roundedCorners(input: Buffer) {
  return sharp(input)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}
const square = await framed(darkTokens.background);
const rounded = await roundedCorners(square);

async function png(input: Buffer, name: string, size: number) {
  await sharp(input).resize(size, size).png().toFile(path(name));
  await writeFile(path(`${name}.license`), assetLicense);
}

// PNG frames in ICO are supported by modern Windows and browser favicon loaders.
async function ico(input: Buffer, name: string, sizes: number[]) {
  const frames = await Promise.all(sizes.map((size) => sharp(input).resize(size).png().toBuffer()));
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    const size = sizes[index] ?? 0;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  await writeFile(path(name), Buffer.concat([header, ...frames]));
  await writeFile(path(`${name}.license`), assetLicense);
}

for (const app of ["web", "www"]) {
  const publicDir = `apps/${app}/public`;
  await png(rounded, `${publicDir}/favicon-16x16.png`, 16);
  await png(rounded, `${publicDir}/favicon-32x32.png`, 32);
  await png(rounded, `${publicDir}/favicon.png`, 128);
  await png(square, `${publicDir}/apple-touch-icon.png`, 180);
  await png(square, `${publicDir}/icon-192.png`, 192);
  await png(square, `${publicDir}/icon-512.png`, 512);
  await ico(rounded, `${publicDir}/favicon.ico`, [16, 32, 48]);
}
await mkdir(path("apps/www/public/brand"), { recursive: true });
await png(rounded, "apps/www/public/brand/orkbot-mark.png", 256);
await png(rounded, "apps/mobile/assets/favicon.png", 128);
await png(square, "apps/desktop/assets/icon.png", 1024);
await ico(rounded, "apps/desktop/assets/icon.ico", [16, 32, 48, 64, 128, 256]);
// Development launches need Dock margins; production macOS uses Icon Composer.
const dock = await sharp(rounded)
  .resize(824, 824)
  .extend({ top: 100, bottom: 100, left: 100, right: 100, background: "transparent" })
  .png()
  .toBuffer();
await png(dock, "apps/desktop/assets/icon-macos.png", 1024);

await png(square, "apps/mobile/assets/icon.png", 1024);
const background = await sharp({
  create: { width: 1024, height: 1024, channels: 4, background: darkTokens.background },
})
  .png()
  .toBuffer();
await png(background, "apps/mobile/assets/icon-background.png", 1024);
// Android masks the foreground. Leave enough room for circular launcher crops.
const adaptive = await sharp(portrait)
  .resize(900, 900)
  .extend({ top: 62, bottom: 62, left: 62, right: 62, background: "transparent" })
  .png()
  .toBuffer();
await png(adaptive, "apps/mobile/assets/adaptive-icon.png", 1024);
const monochrome = await sharp(path("packages/ui-tokens/assets/ork-nunu-monochrome.svg"))
  .resize(900, 900)
  .extend({ top: 62, bottom: 62, left: 62, right: 62, background: "transparent" })
  .png()
  .toBuffer();
await png(monochrome, "apps/mobile/assets/monochrome-icon.png", 1024);

// The splash shows the character alone, with no plate, so it sits on either splash colour.
// Keep the existing transparent padding so its visual size stays stable.
const splash = await sharp(portrait)
  .resize(620, 620)
  .extend({ top: 202, bottom: 202, left: 202, right: 202, background: "transparent" })
  .png()
  .toBuffer();
await png(splash, "apps/mobile/assets/splash-icon.png", 1024);

// Android notification icons must be white alpha silhouettes, with transparent eyes.
const silhouette = await sharp(monochrome).resize(72, 72).extractChannel("alpha").toBuffer();
const notification = await sharp({
  create: { width: 72, height: 72, channels: 3, background: "white" },
})
  .joinChannel(silhouette)
  .png()
  .toBuffer();
await png(notification, "apps/mobile/assets/notification-icon.png", 72);

await mkdir(path("apps/www/public/brand/kit"), { recursive: true });
await png(rounded, "apps/www/public/brand/kit/orkbot-icon.png", 1024);
await png(portrait, "apps/www/public/brand/kit/orkbot-mascot.png", 700);
for (const [name, input] of [
  ["icon", rounded],
  ["mascot", portrait],
] as const) {
  const target = `apps/www/public/brand/kit/orkbot-${name}-preview.webp`;
  await sharp(input).resize(400, 400).webp({ quality: 95 }).toFile(path(target));
  await writeFile(path(`${target}.license`), assetLicense);
}
