// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { createDb } from "../../../packages/db/src/index";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { expect, test } from "./renderer-test";

test("large sidebar sections virtualize rows while scrolling, tabbing and reordering", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stamp = Date.now();
  await signup(page, `virtual-sidebar-${stamp}@orkbot.test`, "password12", "Virtual Sidebar");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  await rpc(page, "onboarding/dismissFocus", { botId: chiefId });
  const { prisma, pool } = createDb(process.env.DATABASE_URL!);
  const ids = Array.from({ length: 180 }, (_, index) => `virtual-${stamp}-${index}`);
  try {
    const chief = await prisma.bot.findUniqueOrThrow({ where: { id: chiefId } });
    await prisma.bot.createMany({
      data: ids.map((id, index) => ({
        id,
        spaceId: chief.spaceId,
        userId: chief.userId,
        color: chief.color,
        name: `Virtual Bot ${String(index).padStart(3, "0")}`,
        position: index + 1,
      })),
    });
    await prisma.thread.createMany({
      data: ids.map((botId) => ({ botId, spaceId: chief.spaceId, userId: chief.userId })),
    });
    await page.reload();
    const sidebar = page.getByTestId("bots-sidebar");
    const scroll = page.getByTestId("sidebar-scroll");
    const rows = sidebar.locator("[data-roster-bot-id]");
    const first = sidebar.locator(`[data-roster-bot-id="${ids[0]}"]`);
    const last = sidebar.locator(`[data-roster-bot-id="${ids.at(-1)}"]`);
    await expect(first).toBeVisible();
    await expect(sidebar.locator("[data-sidebar-virtual-list]")).toHaveCount(1);
    expect(await rows.count()).toBeLessThan(40);
    await expect(last).toHaveCount(0);

    // Tab across the original viewport and its overscan without skipping unmounted rows.
    await first.focus();
    for (let index = 1; index <= 22; index++) {
      await page.keyboard.press("Tab");
      await expect(sidebar.locator(`[data-roster-bot-id="${ids[index]}"]`)).toBeFocused();
    }
    await page.keyboard.press("Shift+Tab");
    const focused = sidebar.locator(`[data-roster-bot-id="${ids[21]}"]`);
    await expect(focused).toBeFocused();
    await page.keyboard.press("Alt+ArrowUp");
    await expect(focused).toBeFocused();
    expect(await rows.count()).toBeLessThan(40);

    // A focused row remains mounted when wheel/scroll moves it outside the visible window.
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(last).toBeVisible();
    await expect(focused).toBeFocused();
    await expect(first).toHaveCount(0);
    expect(await rows.count()).toBeLessThan(40);
    await last.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Move to", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(last).toBeFocused();
    await last.click();
    await expect(page).toHaveURL(new RegExp(`/app/${ids.at(-1)}$`));
    await captureScreenshot(page, testInfo, "sidebar-virtual-bottom");

    await page.getByTestId("minimize-bots-sidebar").click();
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(last).toBeVisible();
    expect(await rows.count()).toBeLessThan(45);
    await page.getByTestId("restore-bots-sidebar").click();

    await page.evaluate(() => localStorage.setItem("orkbot.botsSidebarDensity", "compact"));
    await page.reload();
    await expect(sidebar).toHaveAttribute("data-bots-sidebar-density", "compact");
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(last).toBeVisible();
    expect(await rows.count()).toBeLessThan(45);

    // Pinned quick access retains three columns while virtualizing whole visual rows.
    await prisma.bot.updateMany({ where: { id: { in: ids } }, data: { pinned: true } });
    await page.reload();
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    const pinned = sidebar.locator('[data-sidebar-group="pinned"]');
    await expect(pinned.locator("[data-sidebar-virtual-list]")).toHaveCount(1);
    const pinnedRows = pinned.locator("[data-roster-bot-id]");
    await expect(pinnedRows.first()).toBeVisible();
    expect(await pinnedRows.count()).toBeLessThan(75);
    const firstBoxes = await pinnedRows.evaluateAll((elements) =>
      elements.slice(0, 3).map((element) => element.getBoundingClientRect().top),
    );
    expect(firstBoxes[0]).toEqual(firstBoxes[1]);
    expect(firstBoxes[1]).toEqual(firstBoxes[2]);
    await pinned.getByRole("button", { name: "Collapse Pinned", exact: true }).click();
    await expect(pinnedRows).toHaveCount(0);
    await pinned.getByRole("button", { name: "Expand Pinned", exact: true }).click();
    await expect(pinnedRows.first()).toBeVisible();
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollHeight))
      .toBeGreaterThan(5000);
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(last).toBeVisible();
    expect(await pinnedRows.count()).toBeLessThan(75);
    // The same shared viewport covers the archived and snoozed sections below the roster.
    await prisma.bot.updateMany({
      where: { id: { in: ids } },
      data: { pinned: false, archivedAt: new Date() },
    });
    await page.goto(`/app/${chiefId}`);
    await page.reload();
    const archived = sidebar.locator('[data-sidebar-group="archived"]');
    await archived.getByRole("button", { name: /^Archived/ }).click();
    await expect(archived.locator("[data-sidebar-virtual-list]")).toHaveCount(1);
    expect(
      await archived.getByRole("button", { name: "Restore", exact: true }).count(),
    ).toBeLessThan(40);
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollHeight))
      .toBeGreaterThan(5000);
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(archived.getByText("Virtual Bot 179", { exact: true })).toBeVisible();

    await prisma.bot.updateMany({ where: { id: { in: ids } }, data: { archivedAt: null } });
    const threads = await prisma.thread.findMany({
      where: { botId: { in: ids } },
      select: { id: true },
    });
    await prisma.threadSnooze.createMany({
      data: threads.map((thread) => ({
        threadId: thread.id,
        userId: chief.userId,
        until: new Date(Date.now() + 86_400_000),
      })),
    });
    await page.reload();
    const snoozed = page.getByTestId("snoozed-chats");
    await snoozed.getByRole("button", { name: /^Snoozed/ }).click();
    await expect(snoozed.locator("[data-sidebar-virtual-list]")).toHaveCount(1);
    expect(await snoozed.getByRole("button", { name: /^Wake / }).count()).toBeLessThan(40);
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollHeight))
      .toBeGreaterThan(5000);
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(
      snoozed.getByRole("button", { name: "Wake Virtual Bot 179", exact: true }),
    ).toBeVisible();
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
});
