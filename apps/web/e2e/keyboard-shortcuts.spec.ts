// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved. Native renderer entry selection is an Ork addition.

import { captureScreenshot, completeOnboarding, signup } from "./helpers";
import { expect, test } from "./renderer-test";

test("keyboard shortcuts list and focus the composer", async ({ page }, testInfo) => {
  await signup(page, `shortcuts-${Date.now()}@orkbot.test`, "password12", "Shortcut Keys");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const composer = page.getByRole("combobox", { name: /^Message / });
  await expect(composer).toBeVisible();

  await page.keyboard.press("ControlOrMeta+/");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Command menu")).toBeVisible();
  // The browser keeps these chords, so only the desktop app lists them.
  await expect(dialog.getByText("New group chat")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "keyboard-shortcuts");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await composer.blur();
  await page.keyboard.press("ControlOrMeta+I");
  await expect(composer).toBeFocused();

  await page.keyboard.press("ControlOrMeta+K");
  await page.getByTestId("command-palette-action-keyboard-shortcuts").click();
  await expect(dialog).toBeVisible();
});
