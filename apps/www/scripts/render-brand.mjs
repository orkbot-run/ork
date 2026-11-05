// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to render Nunu brand and roster assets.
// Inherited logo composition remains Apache-2.0. New changes follow LICENSE.md.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createAvatar } from "@orkbot/avatar";
import sharp from "sharp";

const license = "SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0\nSPDX-FileCopyrightText: 2026 Ork contributors\n";
const compositeLicense = "SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0\nSPDX-FileCopyrightText: 2026 Rakazo contributors\nSPDX-FileCopyrightText: 2026 Ork contributors\nInherited wordmark remains Apache-2.0. New Nunu artwork follows LICENSE.md.\n";
async function writeAsset(url, data, notice = license) {
  await writeFile(url, data);
  await writeFile(new URL(`${url.href}.license`), notice);
}

const avatars = new URL("../public/avatars/", import.meta.url);
const jobs = new URL("../public/brand/job-bots/", import.meta.url);
const colors = { indigo: "#6A6BF5", orange: "#F5A03C", violet: "#9B5CF6", coral: "#F2622A", pink: "#D9508A", blue: "#3B82F6", teal: "#3EC5A8" };
function avatar(name, color, accessory = "none") {
  return createAvatar({ name, color, shape: "ork", accessory, satellites: 0, background: "transparent", animate: false }).svg;
}
for (const [name, color] of Object.entries(colors)) {
  await writeAsset(new URL(`bot-avatar-${name}.svg`, avatars), avatar(`${name} Ork`, color));
}
const roster = [
  ["sales-outbound", colors.orange, "headphones"],
  ["inbox-manager", colors.indigo, "none"],
  ["talent-scout", colors.blue, "glasses"],
  ["expense-manager", colors.coral, "none"],
  ["coding-agent", "#5B6EE1", "headphones"],
  ["account-manager", colors.violet, "none"],
  ["paid-media", colors.teal, "star"],
  ["chief-of-staff", "#8B93A8", "glasses"],
];
for (const [name, color, accessory] of roster) {
  const data = await sharp(Buffer.from(avatar(name, color, accessory)))
    .resize(384, 384).webp({ quality: 95 }).toBuffer();
  await writeAsset(new URL(`${name}.webp`, jobs), data);
}

const kit = new URL("../public/brand/kit/", import.meta.url);
const icon = await readFile(new URL("orkbot-icon.png", kit));
const wordmark = await readFile(new URL("orkbot-wordmark.svg", kit));
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1712, height: 576 } });
  await page.setContent(`<!doctype html><html><head><style>
    html, body { margin: 0; width: 1712px; height: 576px; }
    body { display: flex; align-items: center; gap: 96px; }
    .icon { width: 576px; height: 576px; }
    .wordmark { width: 1040px; height: auto; }
  </style></head><body>
    <img class="icon" src="data:image/png;base64,${icon.toString("base64")}" alt="" />
    <img class="wordmark" src="data:image/svg+xml;base64,${wordmark.toString("base64")}" alt="Ork" />
  </body></html>`);
  await page.locator("img").evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  const logo = await page.screenshot({ omitBackground: true });
  await writeAsset(new URL("orkbot-logo.png", kit), logo, compositeLicense);
  const preview = await page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = Math.round((640 * image.height) / image.width);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/webp", 0.95).split(",")[1];
  }, logo.toString("base64"));
  await writeAsset(new URL("orkbot-logo-preview.webp", kit), Buffer.from(preview, "base64"), compositeLicense);
  console.log(`Rendered Ork logo assets in ${fileURLToPath(kit)}`);
} finally {
  await browser.close();
}
