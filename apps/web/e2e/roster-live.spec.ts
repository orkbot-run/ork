// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { completeOnboarding, rpc, signup } from "./helpers";
import { expect, test } from "./renderer-test";

test("the open sidebar shows bot creation and rename from the roster stream", async ({ page }) => {
  await signup(page, `roster-live-${Date.now()}@orkbot.test`, "password12", "Roster Live");
  await completeOnboarding(page);
  const subscribed = page.waitForResponse(
    (response) => response.url().endsWith("/rpc/notifications/subscribe") && response.ok(),
  );
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  await subscribed;
  const sidebar = page.getByTestId("bots-sidebar");
  await expect(sidebar).toBeVisible();

  /* RPC writes bypass optimistic roster state in this renderer. */
  const bot = await rpc<{ id: string }>(page, "bots/create", {
    name: "Roster Stream Fixture",
    description: "",
    instructions: "",
    notifyOnFinish: false,
    computerMode: "team",
  });
  const row = sidebar.locator(`[data-roster-bot-id="${bot.id}"]`);
  await expect(row.getByText("Roster Stream Fixture", { exact: true })).toBeVisible({
    timeout: 7_000,
  });
  await rpc(page, "bots/update", { botId: bot.id, name: "Roster Stream Renamed" });
  await expect(row.getByText("Roster Stream Renamed", { exact: true })).toBeVisible({
    timeout: 7_000,
  });
});
