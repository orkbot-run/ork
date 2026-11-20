// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { UsageBreakdown } from "@orkbot/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";
import { expect, test } from "./renderer-test";

test("usage settings filter real recorded calls, keep deleted bot history, and refresh on completion", async ({
  page,
}, testInfo) => {
  await signup(page, `usage-panel-${Date.now()}@orkbot.test`, "password12", "Usage owner");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "onboarding/dismissFocus", { botId });
  await rpc(page, "bots/update", { botId, replyMode: "chat" });
  const secondary = await rpc<{ id: string }>(page, "bots/create", {
    name: "Usage helper",
    title: "Helper",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });
  await rpc(page, "bots/update", { botId: secondary.id, replyMode: "chat" });
  const load = (input: object = {}) => rpc<UsageBreakdown>(page, "usage/breakdown", input);
  await rpc(page, "threads/send", { botId: secondary.id, text: "Hello from the usage helper." });
  await expect
    .poll(async () => (await load({ botId: secondary.id })).totals.modelCalls)
    .toBeGreaterThan(0);
  await rpc(page, "bots/remove", { botId: secondary.id, deleteMemories: false });
  await expect
    .poll(async () => (await load()).botOptions.find((bot) => bot.botId === secondary.id))
    .toMatchObject({ name: "Usage helper", deleted: true });

  const settings = await openUserSettings(page, "usage");
  const panel = settings.getByTestId("usage-settings");
  const period = panel.getByTestId("usage-range");
  const bot = panel.getByTestId("usage-bot");
  const model = panel.getByTestId("usage-model");
  const calls = panel.getByTestId("usage-stat-modelCalls");
  await expect(period).toHaveValue("30d");
  await period.focus();
  await expect(period).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(bot).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(model).toBeFocused();
  await period.selectOption("today");

  const deleted = panel
    .getByTestId("usage-bots")
    .getByRole("row")
    .filter({ hasText: "Usage helper" });
  await expect(deleted).toContainText("Deleted");
  await bot.selectOption(secondary.id);
  const filtered = await load({ range: "today", botId: secondary.id });
  await expect(calls).toHaveText(String(filtered.totals.modelCalls));
  await expect(panel.getByTestId("usage-bots").getByRole("row")).toHaveCount(2);
  const entry = filtered.models[0]!;
  await model.selectOption(JSON.stringify([entry.provider, entry.model]));
  await expect(panel.getByTestId("usage-models").getByRole("row")).toHaveCount(2);
  await expect(panel.getByTestId("usage-models").getByRole("row").last()).toContainText(
    entry.model,
  );

  const timeline = panel.getByTestId("usage-timeline");
  await expect(timeline.getByRole("img")).toHaveAccessibleName(/Exact values/);
  const values = timeline.getByText("Timeline data", { exact: true }).first();
  await values.focus();
  await page.keyboard.press("Enter");
  await expect(timeline.getByTestId("usage-timeline-data").getByRole("table")).toBeVisible();

  await bot.selectOption("");
  await model.selectOption("");
  const first = await load({ range: "today" });
  await expect(calls).toHaveText(String(first.totals.modelCalls));
  // Keep the Usage panel open and let the ordinary thread stream refresh it.
  const refetched = page.waitForRequest((request) =>
    request.url().endsWith("/rpc/usage/breakdown"),
  );
  await rpc(page, "threads/send", {
    botId,
    text: "Record a fresh model call for the usage panel.",
  });
  await refetched;
  await expect
    .poll(async () => Number((await calls.textContent())?.replace(/[^0-9]/g, "")))
    .toBeGreaterThan(first.totals.modelCalls);

  await period.selectOption("7d");
  await expect(panel.getByTestId("usage-timeline")).toBeVisible();
  await captureScreenshot(page, testInfo, "usage-breakdown-wide");
  await page.setViewportSize({ width: 720, height: 760 });
  await expect(panel).toBeVisible();
  await captureScreenshot(page, testInfo, "usage-breakdown-compact");
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(settings.getByRole("button", { name: "Close user settings" })).toBeVisible();
  expect(await settings.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "usage-breakdown-narrow");
});
