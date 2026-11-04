import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

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
  await writeFile(new URL("orkbot-logo.png", kit), logo);
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
  await writeFile(new URL("orkbot-logo-preview.webp", kit), Buffer.from(preview, "base64"));
  console.log(`Rendered Ork logo assets in ${fileURLToPath(kit)}`);
} finally {
  await browser.close();
}
