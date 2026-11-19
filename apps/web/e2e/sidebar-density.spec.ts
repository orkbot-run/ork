// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved. Native renderer entry selection is an Ork addition.

import { PostgresRealtimeFanout } from "../../../packages/adapters/src/realtime";
import { appendEventInTransaction, createDb, notifyRealtime } from "../../../packages/db/src/index";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";
import { expect, test } from "./renderer-test";

const DENSITY_KEY = "orkbot.botsSidebarDensity";

test("the sidebar follows live steps and reply writing in open and background chats", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await signup(page, `sidebar-live-${Date.now()}@orkbot.test`, "password12", "Sidebar Activity");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "onboarding/dismissFocus", { botId });
  const another = await rpc<{ id: string }>(page, "bots/create", {
    name: "Another Chat",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  const transcript = page.getByTestId("transcript");
  const row = page.locator(`[data-roster-bot-id="${botId}"]`);
  const status = row.locator('[data-roster-status="running"]');
  const connectionString = process.env.DATABASE_URL!;
  const { prisma, pool } = createDb(connectionString);
  const realtime = new PostgresRealtimeFanout({ connectionString, publisher: pool });
  try {
    // Seed a running turn whose progress is controlled by this test.
    const run = await prisma.$transaction(async (tx) => {
      const thread = await tx.thread.findUniqueOrThrow({ where: { botId } });
      const identity = {
        botId,
        threadId: thread.id,
        spaceId: thread.spaceId,
        userId: thread.userId,
      };
      const task = await tx.task.create({
        data: { ...identity, prompt: "Check the project notes", status: "running" },
      });
      return tx.run.create({
        data: { ...identity, taskId: task.id, trigger: "user", status: "running" },
      });
    });
    await page.reload();
    await expect(status).toHaveText("Thinking…");
    await expect(transcript.getByRole("status").filter({ hasText: "Thinking…" })).toBeVisible();
    async function publish(payload: Record<string, unknown>) {
      const event = await prisma.$transaction((tx) =>
        appendEventInTransaction(tx, {
          botId,
          spaceId: run.spaceId,
          threadId: run.threadId,
          runId: run.id,
          type: "thread.progress",
          invalidateRoster: true,
          payload,
        }),
      );
      await notifyRealtime(realtime, run.threadId, event.seq);
    }

    await publish({ text: "Reading project notes.pdf", activity: true });
    await expect(status).toHaveText("Reading project notes.pdf");
    await expect(
      transcript.getByRole("status").filter({ hasText: "Reading project notes.pdf" }),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, "sidebar-live-activity");

    await page.locator(`[data-roster-bot-id="${another.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/app/${another.id}$`));
    await publish({ text: "Checking the summary", activity: true });
    await expect(status).toHaveText("Checking the summary");

    await page.getByTestId("minimize-bots-sidebar").click();
    await expect(row).toHaveAccessibleDescription(/Checking the summary/);
    await row.hover();
    await expect(
      page.locator('[data-slot="tooltip-content"]').filter({ hasText: "Checking the summary" }),
    ).toBeVisible();
    await page.getByTestId("restore-bots-sidebar").click();

    await row.click();
    await expect(page).toHaveURL(new RegExp(`/app/${botId}$`));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await publish({ text: "", activity: true });
    await expect(status).toHaveText("Thinking…");
    await expect(status.locator(".text-shimmer")).toHaveCSS("animation-name", "none");
    await publish({ text: "Here is the project summary.", streaming: true });
    await expect(status).toHaveText("Writing a reply…");
    await expect(
      transcript.getByText("Here is the project summary.", { exact: true }),
    ).toBeVisible();
  } finally {
    await rpc(page, "threads/stop", { botId }).catch(() => {});
    await realtime.close();
    await prisma.$disconnect();
    await pool.end();
  }
});

test("compact bot sidebar hides previews and preserves roster status accessibly", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `sidebar-density-${stamp}@orkbot.test`, "password12", "Sidebar Density");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const selectedBotId = activeBotId(page);
  const previewBot = await rpc<{ id: string }>(page, "bots/create", {
    name: "Compact Sample",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  const preview = `compact-density-preview-${stamp}`;
  await rpc(page, "threads/send", { botId: previewBot.id, text: preview });
  await rpc(page, "threads/stop", { botId: previewBot.id });
  await rpc(page, "threads/markUnread", { botId: previewBot.id });
  await page.reload();

  const sidebar = page.getByTestId("bots-sidebar");
  const selectedRow = page.locator(`[data-roster-bot-id="${selectedBotId}"]`);
  const previewRow = page.locator(`[data-roster-bot-id="${previewBot.id}"]`);
  await expect(sidebar).toHaveAttribute("data-bots-sidebar-density", "comfortable");
  await expect(selectedRow).toHaveAttribute("aria-current", "page");
  await expect(previewRow).toContainText(preview);
  await expect(previewRow.locator("[data-roster-bot-name]")).toHaveText("Compact Sample");
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "sidebar-density-comfortable");
  // Previews stay on one line and end in an ellipsis instead of wrapping.
  await expect(previewRow.locator("[data-roster-preview]")).toHaveCSS("white-space", "nowrap");
  await expect(previewRow.locator("[data-roster-preview]")).toHaveCSS("text-overflow", "ellipsis");
  await expect(previewRow).toHaveAttribute("data-roster-unread", "true");
  await expect(previewRow).toHaveAccessibleName(/Compact Sample.*unread/i);
  // The unread dot is the one blue in the sidebar, not ink.
  await expect(previewRow.locator("[data-roster-unread-dot]")).toHaveCSS(
    "background-color",
    "rgb(11, 109, 211)",
  );
  // Times are tertiary text; a hovered row takes the light hover fill, lighter than selection.
  await expect(previewRow.locator("[data-roster-time]")).toHaveCSS(
    "color",
    "rgba(28, 28, 28, 0.56)",
  );
  await previewRow.hover();
  await expect(previewRow).toHaveCSS("background-color", "rgba(28, 28, 28, 0.06)");
  await expect(selectedRow).toHaveCSS("background-color", "rgba(28, 28, 28, 0.08)");
  // Once read, the preview is secondary text.
  await rpc(page, "threads/markRead", { botId: previewBot.id });
  await page.reload();
  await expect(previewRow).not.toHaveAttribute("data-roster-unread", "true");
  await expect(previewRow.locator("[data-roster-preview]")).toHaveCSS(
    "color",
    "rgba(28, 28, 28, 0.68)",
  );
  await rpc(page, "threads/markUnread", { botId: previewBot.id });
  await page.reload();
  await expect(previewRow).toHaveAttribute("data-roster-unread", "true");
  await previewRow.scrollIntoViewIfNeeded();
  const comfortableHeight = await previewRow.evaluate(
    (element) => element.getBoundingClientRect().height,
  );

  const settings = await openUserSettings(page);
  const compact = settings.getByTestId("bots-sidebar-density-compact");
  await compact.scrollIntoViewIfNeeded();
  await compact.click();
  await expect(compact).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => page.evaluate((key) => window.localStorage.getItem(key), DENSITY_KEY))
    .toBe("compact");
  await settings.getByRole("button", { name: "Close user settings" }).click();

  await expect(sidebar).toHaveAttribute("data-bots-sidebar-density", "compact");
  await expect(previewRow).not.toContainText(preview);
  await expect(previewRow).not.toContainText("Field notes");
  await expect(previewRow.locator("[data-roster-preview]")).toHaveCount(0);
  await expect(previewRow).toHaveAttribute("data-roster-unread", "true");
  await expect(previewRow).toHaveAccessibleName(/Compact Sample.*unread/i);
  const compactHeight = await previewRow.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect(compactHeight).toBeLessThan(comfortableHeight);
  expect(compactHeight).toBeGreaterThanOrEqual(44);
  await captureScreenshot(page, testInfo, "sidebar-density-compact-unread");

  await page.reload();
  await expect(sidebar).toHaveAttribute("data-bots-sidebar-density", "compact");
  await expect(previewRow).not.toContainText(preview);
  await expect(previewRow).toHaveAttribute("data-roster-unread", "true");

  await previewRow.focus();
  await expect(previewRow).toBeFocused();
  await previewRow.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/app/${previewBot.id}$`));
  await expect(previewRow).toHaveAttribute("aria-current", "page");
  await expect(previewRow).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");

  const composer = page.locator('textarea[name="chat-message"]');
  try {
    await composer.fill("keep working until I stop you");
    await composer.press("Enter");
    await expect(previewRow.locator('[data-roster-status="running"]')).toHaveText(
      "still working…",
      {
        timeout: 30_000,
      },
    );
    await expect(previewRow.locator('[data-working="true"]')).toBeVisible();
    await expect(previewRow.locator('[data-roster-status="running"]')).toHaveClass(
      /text-muted-foreground/,
    );
    await expect(previewRow.locator('[data-roster-status="running"]')).toHaveCSS(
      "font-weight",
      "500",
    );
    await expect(previewRow).not.toContainText("keep working until I stop you");
    await captureScreenshot(page, testInfo, "sidebar-density-compact-working");
  } finally {
    await rpc(page, "threads/stop", { botId: previewBot.id }).catch(() => undefined);
  }

  await composer.fill("fail this run");
  await composer.press("Enter");
  await expect(page.getByTestId("composer-error")).toBeVisible({ timeout: 30_000 });
  await expect(previewRow).toHaveAttribute("data-roster-error", "true");
  await expect(previewRow.locator('[data-roster-status="error"]')).toContainText("Error");
  await captureScreenshot(page, testInfo, "sidebar-density-compact-error");

  await selectedRow.click();
  await expect(page).toHaveURL(new RegExp(`/app/${selectedBotId}$`));
  await expect(previewRow).toHaveAttribute("data-roster-error", "true");
  await expect(previewRow.locator('[data-roster-status="error"]')).toContainText("Error");

  await previewRow.click();
  const composerError = page.getByTestId("composer-error");
  await expect(composerError).toContainText("Scripted run failure");
  await page.getByTestId("composer-error-dismiss").click();
  await expect(composerError).toBeHidden();
  await expect(previewRow).not.toHaveAttribute("data-roster-error", "true");
});
