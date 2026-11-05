// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 coverage is preserved. Generator avatar defaults are an Ork addition.

import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openBotPanelTab, signup } from "./helpers";

test("new bots use Ork generator avatars and keep explicit appearance choices", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `avatar-studio-${stamp}@orkbot.test`, "password12", "Avatar Studio");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.locator(".orkbot-logo-avatar").first()).toBeVisible();

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

  await expect(studio.getByRole("tab", { name: "Ork", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(studio.locator(".orkbot-logo-avatar").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "avatar-studio-generator-default");
  await studio.getByRole("tab", { name: "Original", exact: true }).click();
  const defaultLook = studio.getByTestId("avatar-studio-default");
  const wedge = studio.getByRole("button", { name: "wedge", exact: true });
  await expect(defaultLook).toHaveAttribute("aria-pressed", "true");
  await expect(wedge).toHaveAttribute("aria-pressed", "false");

  await wedge.click();
  await expect(wedge).toHaveAttribute("aria-pressed", "true");
  await expect(defaultLook).toHaveAttribute("aria-pressed", "false");
  await expect(studio.locator(".orkbot-organic-avatar")).toHaveCount(0);

  await defaultLook.click();
  await expect(defaultLook).toHaveAttribute("aria-pressed", "true");
  await expect(wedge).toHaveAttribute("aria-pressed", "false");
  await expect(studio.locator(".orkbot-organic-avatar")).toHaveCount(1);
  await expect(studio.locator(".orkbot-organic-avatar-eyes").first()).toBeVisible();

  await studio.getByRole("button", { name: "Color #FFAF38" }).click();
  await expect(defaultLook).toHaveAttribute("aria-pressed", "true");
  await expect(wedge).toHaveAttribute("aria-pressed", "false");

  await wedge.click();
  await studio.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(defaultLook).toHaveAttribute("aria-pressed", "true");
  await expect(wedge).toHaveAttribute("aria-pressed", "false");
  await expect(studio.locator(".orkbot-organic-avatar")).toHaveCount(1);

  await captureScreenshot(page, testInfo, "avatar-studio-bot-tab");
  await studio.getByRole("tab", { name: "Ork", exact: true }).click();
  await expect(studio.locator(".orkbot-logo-avatar").first()).toBeVisible();
  await studio.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await openBotPanelTab(page, "Computer");
  await page.getByTestId("bot-settings").getByTestId("avatar-studio-trigger").click();
  await expect(
    page.getByTestId("avatar-studio").getByRole("tab", { name: "Ork", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await captureScreenshot(page, testInfo, "avatar-studio-orkbot-set");
});
