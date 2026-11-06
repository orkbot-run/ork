// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 coverage is preserved. Generator avatar defaults are an Ork addition.

import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  signup,
} from "./helpers";
import { expect, test } from "./renderer-test";

/** Paint IDs and animation phases can change without changing a saved bot's appearance. */
function renderedVariant(node: Element) {
  const attributes = [
    "d",
    "x",
    "y",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "width",
    "height",
    "points",
    "transform",
    "stroke-width",
  ];
  return {
    traits: ["shape", "eyes", "mouth", "accessory"].map((name) =>
      node.getAttribute(`data-${name}`),
    ),
    geometry: [
      ...node.querySelectorAll(
        ".logo-avatar-body > g:first-child :is(path, rect, circle, ellipse, polygon, polyline, line)",
      ),
    ]
      .filter((part) => !part.closest("defs"))
      .map((part) => [part.localName, ...attributes.map((name) => part.getAttribute(name))]),
  };
}

test("new bots keep their generated variant when colors change and after reload", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `avatar-studio-${stamp}@orkbot.test`, "password12", "Avatar Studio");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.locator(".orkbot-logo-avatar").first()).toBeVisible();
  const botId = activeBotId(page);

  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();

  await settings.getByTestId("avatar-studio-trigger").click();
  const studio = page.getByTestId("avatar-studio");
  await expect(studio).toBeVisible();
  await expect(studio.getByText("Avatar Studio", { exact: true })).toBeVisible();
  await expect(studio.getByRole("tab", { name: "Bot", exact: true })).toBeVisible();
  await expect(studio.getByRole("tab", { name: "Upload", exact: true })).toBeVisible();
  await expect(studio.getByTestId("avatar-studio-bot-tab")).toBeVisible();

  await expect(studio.getByRole("tab", { name: "Original", exact: true })).toHaveCount(0);
  await expect(studio.getByRole("button", { name: "wedge", exact: true })).toHaveCount(0);
  await expect(page.locator(".orkbot-organic-avatar, .bot-character-eyes")).toHaveCount(0);
  const preview = studio.locator(".orkbot-logo-avatar").first();
  await expect(preview).toBeVisible();
  const variant = await preview.evaluate(renderedVariant);
  expect(variant.traits.every(Boolean)).toBe(true);
  expect(variant.geometry.length).toBeGreaterThanOrEqual(4);
  await captureScreenshot(page, testInfo, "avatar-studio-generator-default");

  const originalColor = await preview.getAttribute("data-color");
  const chosenColor = originalColor?.toLowerCase() === "#ffaf38" ? "#2A92FE" : "#FFAF38";
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/rpc/bots/update" &&
      response.request().method() === "POST",
  );
  await studio.getByRole("button", { name: `Color ${chosenColor}`, exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(preview).toHaveAttribute("data-color", new RegExp(`^${chosenColor}$`, "i"));
  expect(await preview.evaluate(renderedVariant)).toEqual(variant);
  await captureScreenshot(page, testInfo, "avatar-studio-bot-tab");
  await studio.getByRole("button", { name: "Done", exact: true }).click();

  await page.reload();
  expect(activeBotId(page)).toBe(botId);
  await openBotPanelTab(page, "Computer");
  await page.getByTestId("bot-settings").getByTestId("avatar-studio-trigger").click();
  const restored = page.getByTestId("avatar-studio").locator(".orkbot-logo-avatar").first();
  await expect(restored).toBeVisible();
  await expect(restored).toHaveAttribute("data-color", new RegExp(`^${chosenColor}$`, "i"));
  expect(await restored.evaluate(renderedVariant)).toEqual(variant);
  await page
    .getByTestId("avatar-studio")
    .getByRole("button", { name: "Reset", exact: true })
    .click();
  expect(await restored.evaluate(renderedVariant)).toEqual(variant);
  await expect(page.locator(".orkbot-organic-avatar, .bot-character-eyes")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "avatar-studio-generated-variant");
});
