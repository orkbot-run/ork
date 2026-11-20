// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { MeetingDetail, MeetingSummary } from "@orkbot/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  rpc,
  signup,
} from "./helpers";
import { expect, test } from "./renderer-test";

test.skip(process.env.ORKBOT_MEETING_PROVIDER !== "emulator", "Uses the offline meeting provider");

test("a pasted meeting link becomes a reviewed invitation and a speaker-labelled transcript", async ({
  page,
}, testInfo) => {
  await signup(page, `meeting-owner-${Date.now()}@orkbot.test`, "password12", "Meeting owner");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "onboarding/dismissFocus", { botId });
  await rpc(page, "bots/update", { botId, replyMode: "chat" });
  const composer = page.getByRole("combobox", { name: "Message Chief", exact: true });
  await composer.fill("https://meet.google.com/abc-defg-hij");
  await page.getByRole("button", { name: "Review meeting invitation" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Meeting link")).toHaveValue(
    "https://meet.google.com/abc-defg-hij",
  );
  await expect(dialog.getByText(/Inform every participant/)).toBeVisible();
  const join = dialog.getByRole("button", { name: "Join meeting", exact: true });
  await join.click();
  expect(await rpc<MeetingSummary[]>(page, "meetings/list", { botId })).toEqual([]);
  await dialog.getByLabel("Title (optional)").fill("Launch planning");
  await dialog.getByRole("checkbox", { name: /I have informed all participants/ }).check();
  await join.click();
  await expect(dialog.getByText("Launch planning", { exact: true })).toBeVisible();
  const meetings = await rpc<MeetingSummary[]>(page, "meetings/list", { botId });
  expect(meetings).toHaveLength(1);
  const meetingId = meetings[0]!.id;
  await expect
    .poll(async () => {
      const detail = await rpc<MeetingDetail>(page, "meetings/get", { meetingId });
      return detail.transcript.map(({ speaker }) => speaker);
    })
    .toEqual(["Alice", "Bob"]);
  await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(dialog.getByText("I will send the launch plan by Friday.")).toBeVisible();
  await captureScreenshot(page, testInfo, "meeting-transcript");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await composer.fill(`Read meeting fixture ${meetingId}`);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("paragraph").filter({ hasText: /^Meeting transcript checked\.$/ }),
  ).toBeVisible();

  await openBotPanelTab(page, "Meetings");
  await page.getByRole("button", { name: /Launch planning/ }).click();
  await expect(page.getByText("I will send the launch plan by Friday.")).toBeVisible();
  await page.getByRole("button", { name: "Delete meeting", exact: true }).click();
  await page.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(page.getByText("No meetings yet.")).toBeVisible();
  expect(await rpc<MeetingSummary[]>(page, "meetings/list", { botId })).toEqual([]);

  const start = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  await composer.fill(`Schedule meeting fixture ${start}`);
  await page.keyboard.press("Enter");
  await expect(
    page.getByTestId("transcript").getByText("Record meeting audio?", { exact: true }),
  ).toBeVisible();
  expect(await rpc<MeetingSummary[]>(page, "meetings/list", { botId })).toEqual([]);
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect
    .poll(async () => (await rpc<MeetingSummary[]>(page, "meetings/list", { botId }))[0])
    .toMatchObject({ title: "Calendar fixture", status: "scheduled", scheduledAt: start });
});
