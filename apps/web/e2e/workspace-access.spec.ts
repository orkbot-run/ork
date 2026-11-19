// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { captureScreenshot } from "./helpers";
import { expect, test } from "./renderer-test";

test("a removed workspace closes its product view and explains how to continue", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    Object.defineProperty(window, "orkbotDesktop", {
      value: {
        platform: "linux",
        nativeWindowFrame: true,
        accounts: { workspaceAccess: async () => false },
        server: {
          change: async () => {
            document.documentElement.dataset.workspacePicker = "opened";
          },
        },
      },
    });
  });
  await page.goto("/app");
  const dialog = page.getByRole("alertdialog", { name: "Workspace unavailable" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("This workspace was closed or your access was removed.");
  await captureScreenshot(page, testInfo, "workspace-unavailable");
  await dialog.getByRole("button", { name: "Choose workspace" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-workspace-picker", "opened");
});
