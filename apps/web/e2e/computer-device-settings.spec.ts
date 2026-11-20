// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { USER_DEVICE_PATH } from "@orkbot/contracts";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";
import { expect, test } from "./renderer-test";

test("settings identifies the paired computer used by bots", async ({ page }, testInfo) => {
  await signup(
    page,
    `computer-settings-${Date.now()}@orkbot.test`,
    "password12",
    "Computer Tester",
  );
  await completeOnboarding(page);
  const linkedName = "A very long laptop name for checking narrow computer settings layouts";
  await page.route(`**${USER_DEVICE_PATH}`, (route) =>
    route.fulfill({
      json: {
        devices: [
          {
            deviceId: "paired-laptop",
            name: linkedName,
            platform: "darwin",
            connected: true,
            defaultForBots: true,
          },
          {
            deviceId: "paired-desktop",
            name: "Desk PC",
            platform: "win32",
            connected: true,
            defaultForBots: false,
          },
        ],
      },
    }),
  );
  const settings = await openUserSettings(page);
  const computers = settings.getByTestId("computer-devices");
  const linkedRow = computers.locator("p").filter({ hasText: linkedName });
  const otherRow = computers.locator("p").filter({ hasText: "Desk PC" });
  await expect(linkedRow.getByText("Linked to bots", { exact: true })).toBeVisible();
  await expect(otherRow.getByText("Connected", { exact: true })).toBeVisible();
  await expect(computers.getByText("Linked to bots", { exact: true })).toHaveCount(1);
  await expect(otherRow.getByText("Linked to bots", { exact: true })).toHaveCount(0);
  await computers.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "computer-settings-linked-to-bots");

  await page.setViewportSize({ width: 390, height: 844 });
  const language = settings.getByTestId("ui-locale-select");
  await language.scrollIntoViewIfNeeded();
  await language.click();
  await page.getByRole("option", { name: "Polski", exact: true }).click();
  await expect(linkedRow.getByText("Powiązany z botami", { exact: true })).toBeVisible();
  await expect(computers.getByText("Powiązany z botami", { exact: true })).toHaveCount(1);
  await expect(otherRow.getByText("Powiązany z botami", { exact: true })).toHaveCount(0);
  await computers.scrollIntoViewIfNeeded();
  expect(await computers.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(
    computers.getByRole("button", { name: `Usuń ${linkedName}`, exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-settings-linked-to-bots-narrow-pl");
});
