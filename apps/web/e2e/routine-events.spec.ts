// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { createHmac } from "node:crypto";
import type { Routine, RunsListOutput } from "@orkbot/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  rpc,
  signup,
} from "./helpers";
import { expect, test } from "./renderer-test";

test("chat creates event-only routines which run on authenticated incoming events", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-events-${stamp}@orkbot.test`, "password12", "Event owner");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "onboarding/dismissFocus", { botId });
  await rpc(page, "bots/update", { botId, replyMode: "chat" });
  const composer = page.getByPlaceholder(/Message/);
  const finished = page.getByRole("paragraph").filter({ hasText: /^Routine tool finished\.$/ });
  async function tool(value: string, number: number) {
    await expect(composer).toBeEnabled();
    await composer.fill(`Routine event fixture ${value}`);
    await page.keyboard.press("Enter");
    const allow = page.getByRole("button", { name: "Allow once", exact: true });
    await expect(finished.nth(number - 1).or(allow)).toBeVisible();
    if (await allow.isVisible()) await allow.click();
    await expect(finished).toHaveCount(number);
  }
  const routines = () => rpc<Routine[]>(page, "routines/list", { botId });
  await tool("hooks", 1);
  const created = (await routines()).find((routine) => routine.name === "Project events");
  expect(created).toMatchObject({
    active: true,
    crons: [],
    webhookEnabled: true,
    githubEnabled: true,
    nextRunAt: null,
  });
  const routineId = created!.id;
  await tool("chat", 2);
  expect((await routines()).find((routine) => routine.name === "Telegram events")).toMatchObject({
    active: true,
    crons: [],
    messageProvider: "telegram",
    nextRunAt: null,
  });

  const key = await rpc<{ secret: string; path: string }>(page, "bots/getWebhookConfig", { botId });
  const sameKey = await rpc<{ secret: string }>(page, "bots/rotateWebhookSecret", {
    botId,
    onlyIfMissing: true,
  });
  expect(sameKey.secret === key.secret).toBe(true);
  expect((await page.locator("body").innerText()).includes(key.secret)).toBe(false);
  const api = process.env.API_URL ?? "http://127.0.0.1:3110";
  const callback = await page.request.post(`${api}${key.path}`, {
    headers: { authorization: `Bearer ${key.secret}`, "idempotency-key": `project-${stamp}` },
    data: { id: `project-${stamp}`, summary: "Test project updated" },
  });
  expect(callback.ok()).toBe(true);
  const webhookRun = (await callback.json()) as { runId: string };

  async function github(delivery: string) {
    const data = JSON.stringify({
      action: "opened",
      repository: { full_name: "example/test" },
      pull_request: { number: 42 },
    });
    const digest = createHmac("sha256", key.secret).update(data).digest("hex");
    return page.request.post(`${api}/api/v1/bots/${botId}/github`, {
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${digest}`,
        "content-type": "application/json",
      },
      data,
    });
  }
  async function expectCompletedProjectRun(runId: string) {
    expect(runId).toBeTruthy();
    await expect
      .poll(async () => {
        const { runs } = await rpc<RunsListOutput>(page, "runs/list", { filter: "recent" });
        return runs.find((run) => run.runId === runId);
      })
      .toMatchObject({
        status: "completed",
        promptSnippet: expect.stringContaining('Run routine "Project events":'),
      });
  }
  await expectCompletedProjectRun(webhookRun.runId);
  const delivery = await github(`github-${stamp}`);
  expect(delivery.ok()).toBe(true);
  const githubRun = (await delivery.json()) as { runId: string };
  expect(githubRun.runId).not.toBe(webhookRun.runId);
  await expectCompletedProjectRun(githubRun.runId);

  await tool(`edit ${routineId}`, 3);
  expect((await routines()).find((routine) => routine.id === routineId)).toMatchObject({
    webhookEnabled: true,
    githubEnabled: false,
    crons: [],
  });
  expect(await (await github(`github-disabled-${stamp}`)).json()).toMatchObject({ ignored: true });

  await page.reload();
  await openBotPanelTab(page, "Routines");
  await page.getByRole("button", { name: /Project events/ }).click();
  await expect(page.getByRole("button", { name: /Reveal key/ })).toBeVisible();
  await captureScreenshot(page, testInfo, "event-routine-config");
});
