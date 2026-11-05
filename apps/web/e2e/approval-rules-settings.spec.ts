// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material; Ork additions are covered by PolyForm Noncommercial.

import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("adds a tool rule and switches it between Ask and Block", async ({ page }, testInfo) => {
  await signup(page, `approval-rules-${Date.now()}@orkbot.test`, "password12", "Permissions");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-confirmations").click();
  await settings.getByRole("button", { name: "Add rule", exact: true }).click();
  const toolName = settings.getByRole("textbox", { name: "Tool name" });
  await toolName.fill("write_file");
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

test("sets an account spending limit including PLN", async ({ page }, testInfo) => {
  await signup(page, `spending-limit-${Date.now()}@orkbot.test`, "password12", "Purchases");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-confirmations").click();
  const budget = settings.getByTestId("spending-limit-settings");
  await budget.getByRole("button", { name: "Set limit", exact: true }).click();
  await budget.getByRole("textbox", { name: "Amount", exact: true }).fill("150.50");
  await budget.getByRole("combobox", { name: "Currency", exact: true }).selectOption("PLN");
  await budget
    .getByRole("combobox", { name: "Reset period (UTC)", exact: true })
    .selectOption("weekly");
  await captureScreenshot(page, testInfo, "account-spending-limit-form");
  await budget.getByRole("button", { name: "Save limit", exact: true }).click();
  await expect(budget).toContainText("PLN 150.50");
  await captureScreenshot(page, testInfo, "account-spending-limit-saved");
  await settings.getByTestId("settings-nav-models").click();
  await settings.getByTestId("settings-nav-confirmations").click();
  await expect(settings.getByTestId("spending-limit-settings")).toContainText("PLN 150.50");
  await budget.getByRole("button", { name: "Remove limit", exact: true }).click();
  await expect(budget.getByRole("button", { name: "Set limit", exact: true })).toBeVisible();
});
