// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Modified by Ork contributors for empty-space onboarding recovery. See LICENSE.md.

import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openNewSpace, rpc, signup } from "./helpers";

test("a new space chooses what it can use, and a skill can be limited to some spaces", async ({
  page,
}, testInfo) => {
  await signup(page, `availability-${Date.now()}@orkbot.test`, "password12", "Space Owner");
  await completeOnboarding(page);
  const { spaceId: personalSpaceId } = await rpc<{ spaceId: string }>(page, "me", {});
  await rpc(page, "agentSkills/create", {
    content: [
      "---",
      "name: weekly-review",
      "description: Summarize the week's progress and blockers.",
      "---",
      "",
      "List what shipped, what slipped, and what is blocked.",
    ].join("\n"),
  });

  await openNewSpace(page);
  const create = page.getByRole("dialog", { name: "New space" });
  await create.getByLabel("Name").fill("Clients");
  await create.getByRole("button", { name: "Create space", exact: true }).click();

  // What the user added reaches every space, so it starts ticked and can be left out here.
  const chooser = page.getByRole("dialog", { name: "What can this space use?" });
  const item = chooser.getByRole("checkbox", { name: "weekly-review", exact: true });
  await expect(item).toBeChecked();
  await captureScreenshot(page, testInfo, "new-space-items");
  await item.click();
  await expect(item).not.toBeChecked();
  await chooser.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(chooser).toHaveCount(0);

  // Wait for the new Space's bot before leaving, so its late navigation cannot undo the switch.
  const sidebar = page.locator("aside").first();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("orkbot:space-id")))
    .not.toBe(personalSpaceId);
  await completeOnboarding(page);
  await expect(page).toHaveURL(/\/app\/[^/]+$/);
  await expect(sidebar.getByText("Clients", { exact: true })).toBeVisible();
  const clients = sidebar.locator('[data-sidebar-group^="space:"]').filter({ hasText: "Clients" });
  await expect(clients.getByRole("button", { name: /^Chief/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const chiefs = sidebar.getByRole("button", { name: /^Chief/ });
  await expect(chiefs).toHaveCount(2);
  const personalChief = chiefs.first();
  await personalChief.click();
  await expect(personalChief).toHaveAttribute("aria-current", "page");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("orkbot:space-id")))
    .toBe(personalSpaceId);
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  const skills = page.getByRole("dialog", { name: "Skills", exact: true });
  const yours = skills.getByTestId("your-skills");
  await yours.getByRole("button", { name: /weekly-review/ }).click();
  const availability = yours.getByTestId("availability");
  await expect(availability).toContainText("Available in");
  await availability.getByRole("button", { name: /Personal/ }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Personal" })).toBeChecked();
  await expect(page.getByRole("menuitemcheckbox", { name: "Clients" })).not.toBeChecked();
  await captureScreenshot(page, testInfo, "skill-available-in");
});
