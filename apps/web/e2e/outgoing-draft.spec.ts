// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { CLIENT_PROTOCOL_HEADER, CLIENT_PROTOCOL_VERSION } from "@orkbot/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { expect, test } from "./renderer-test";

test("an edited Gmail draft is sent once after reviewing a changed recipient", async ({
  page,
}, testInfo) => {
  const id = Date.now();
  await signup(page, `outgoing-${id}@orkbot.test`, "password12", "Draft reviewer");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "onboarding/dismissFocus", { botId });
  await rpc(page, "bots/update", { botId, replyMode: "chat" });
  const composer = page.getByPlaceholder(/Message/);
  async function prompt(text: string) {
    await expect(composer).toBeEnabled();
    await composer.fill(text);
    await page.keyboard.press("Enter");
  }

  await prompt("Can you check my Gmail inbox?");
  const connect = page.getByRole("group", { name: "Gmail connection", exact: true });
  await connect.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(connect.getByText("Connected", { exact: true })).toBeVisible();
  await prompt(`Outgoing draft fixture ${id}`);

  const draft = page.getByTestId("outgoing-draft-card").last();
  const recipient = draft.getByLabel("To", { exact: true });
  const subject = draft.getByLabel("Subject", { exact: true });
  const body = draft.getByLabel("Message body", { exact: true });
  const send = draft.getByRole("button", { name: "Send", exact: true });
  await expect(recipient).toHaveValue("original@example.test");
  await expect(subject).toHaveValue(`Fixture draft ${id}`);
  await expect(body).toHaveValue("Original fixture body");
  await expect(draft.getByRole("button", { name: /Always allow/ })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "outgoing-draft");

  const api = process.env.API_URL ?? "http://127.0.0.1:3110";
  async function deliveries() {
    const response = await page.request.get(`${api}/__e2e/outgoing-draft-deliveries`);
    expect(response.ok()).toBe(true);
    const calls = (await response.json()) as { args: Record<string, unknown> }[];
    return calls.filter((call) => String(call.args.subject).endsWith(String(id)));
  }

  await body.fill(" ");
  await send.click();
  await expect(draft.getByRole("alert")).toHaveText("Enter a message body");
  expect(await deliveries()).toHaveLength(0);
  await recipient.fill("edited@example.test");
  await subject.fill(`Edited draft ${id}`);
  await body.fill("Edited first line.\nSecond line.");
  const first = page.waitForRequest((request) => request.url().includes("/rpc/threads/answer"));
  await send.click();
  const submitted = await first;
  await expect(draft.getByText(/Recipient changed/)).toBeVisible();
  await expect(send).toBeEnabled();
  expect(await deliveries()).toHaveLength(0);

  async function replayFirstAnswer() {
    return page.request.post("/rpc/threads/answer", {
      headers: { [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL_VERSION) },
      data: submitted.postDataJSON(),
    });
  }
  expect((await replayFirstAnswer()).status()).toBe(409);
  await expect(recipient).toHaveValue("edited@example.test");
  await captureScreenshot(page, testInfo, "outgoing-draft-recipient-review");
  await send.click();
  await expect.poll(deliveries).toEqual([
    expect.objectContaining({
      args: expect.objectContaining({
        recipient_email: "edited@example.test",
        subject: `Edited draft ${id}`,
        body: "Edited first line.\nSecond line.",
      }),
    }),
  ]);
  expect((await replayFirstAnswer()).status()).toBe(409);
  await expect(draft.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);

  await prompt(`Outgoing draft fixture ${id + 1}`);
  await expect(subject).toHaveValue(`Fixture draft ${id + 1}`);
  await draft.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(draft.getByText("Denied", { exact: true })).toBeVisible();
  await expect(composer).toBeEnabled();
  const response = await page.request.get(`${api}/__e2e/outgoing-draft-deliveries`);
  expect(JSON.stringify(await response.json())).not.toContain(`Fixture draft ${id + 1}`);
  expect(await deliveries()).toHaveLength(1);
});
