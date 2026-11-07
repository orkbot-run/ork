// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved. Searchable catalog selection and effective choices are Ork additions.

import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";
import { expect, test } from "./renderer-test";

test("adds a tool rule and switches it between Ask and Block", async ({ page }, testInfo) => {
  await signup(page, `approval-rules-${Date.now()}@orkbot.test`, "password12", "Permissions");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-confirmations").click();
  await settings.getByRole("button", { name: "Add rule", exact: true }).click();
  await settings.getByRole("button", { name: "Tool", exact: true }).click();
  const search = page.getByRole("combobox", { name: "Tools", exact: true });
  await search.fill("missing-tool-example");
  await expect(page.getByText("No tools found.", { exact: true })).toBeVisible();
  await search.fill("");
  await expect(page.getByRole("option", { name: "Write file", exact: true })).toBeVisible();
  await search.fill("write_file");
  await captureScreenshot(page, testInfo, "approval-rule-catalog");
  await page.getByRole("option", { name: "Write file", exact: true }).click();
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  const rule = settings.getByRole("group", { name: "Write file", exact: true });
  await expect(rule.getByRole("button", { name: "Ask", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await rule.getByRole("button", { name: "Block", exact: true }).click();
  await expect(rule.getByRole("button", { name: "Block", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await captureScreenshot(page, testInfo, "approval-rules-added");
});
