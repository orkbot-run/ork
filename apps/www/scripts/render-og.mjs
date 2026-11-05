// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to refresh Nunu social cards and asset notices.
// Inherited rendering remains Apache-2.0. New changes follow LICENSE.md.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { ogPages } from "../src/og-pages.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public/og");
const mark = (await readFile(join(root, "public/brand/orkbot-mark.png"))).toString("base64");

function pageHtml(kicker, title) {
  const fontSize = title.length > 72 ? 40 : 68;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; width: 1200px; height: 630px; background: #fdfdfd; }
    body { font-family: Geist, ui-sans-serif, system-ui, sans-serif; color: #242424; }
    .card { box-sizing: border-box; width: 1200px; height: 630px; padding: 72px 80px; display: flex; flex-direction: column; justify-content: space-between; }
    .kicker { margin: 0; color: #6d6e70; font-size: 22px; letter-spacing: 0.08em; text-transform: uppercase; }
    h1 { margin: 18px 0 0; max-width: 980px; font-size: ${fontSize}px; line-height: 1.05; font-weight: 560; letter-spacing: -0.03em; }
    .brand { display: flex; align-items: center; gap: 14px; font-size: 28px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <div>
      <p class="kicker">${kicker}</p>
      <h1>${title.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</h1>
    </div>
    <div class="brand">
      <img width="36" height="36" src="data:image/png;base64,${mark}" alt="" />
      Ork
    </div>
  </div>
</body>
</html>`;
}


await mkdir(outDir, { recursive: true });
const selected = new Set(process.argv.slice(2));
const pages = [
  { id: "home", kicker: "Source-available AI teammates", title: "AI teammates you actually own" },
  ...ogPages(),
].filter((page) => selected.size === 0 || selected.has(page.id));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  for (const item of pages) {
    await page.setContent(pageHtml(item.kicker, item.title));
    await page.locator("img").evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
    const target = item.id === "home" ? join(root, "public/og-image.png") : join(outDir, `${item.id}.png`);
    await page.screenshot({ path: target });
    await writeFile(`${target}.license`, "SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0\nSPDX-FileCopyrightText: 2026 Rakazo contributors\nSPDX-FileCopyrightText: 2026 Ork contributors\nInherited card layout and copy remain Apache-2.0. New Nunu artwork follows LICENSE.md.\n");
    console.log(item.id);
  }
} finally {
  await browser.close();
}
