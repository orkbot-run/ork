// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { CLIENT_PROTOCOL_HEADER, CLIENT_PROTOCOL_VERSION } from "@orkbot/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { expect, test } from "./renderer-test";

test("the worker returns chat form responses to the same running MCP tool", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `mcp-form-${stamp}@orkbot.test`, "password12", "Project runner");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "onboarding/dismissFocus", { botId });
  await rpc(page, "bots/update", { botId, replyMode: "chat" });
  const server = await rpc<{ id: string }>(page, "mcp/servers/create", {
    slug: "project-forms",
    name: "Project forms",
    transport: "streamable_http",
    endpoint: "https://project-forms.example.test/mcp",
  });
  await rpc(page, "mcp/servers/agents", { id: server.id, allBots: true, botIds: [] });
  await rpc(page, "mcp/servers/test", { id: server.id });

  const composer = page.getByPlaceholder(/Message/);
  const form = page.getByTestId("mcp-form-card").last();
  const finished = page.getByRole("paragraph").filter({ hasText: /^Project tool finished\.$/ });
  const api = process.env.API_URL ?? "http://127.0.0.1:3110";
  const answers = async () => (await page.request.get(`${api}/__e2e/mcp-form-answers`)).json();
  async function ask(index: number) {
    await expect(composer).toBeEnabled();
    await composer.fill(`MCP form fixture ${stamp + index}`);
    await page.keyboard.press("Enter");
    const approval = page.getByRole("button", { name: "Allow once", exact: true }).last();
    const accept = form.getByRole("button", { name: "Submit", exact: true });
    await expect(accept.or(approval)).toBeVisible();
    if (await approval.isVisible()) await approval.click();
    await expect(accept).toBeEnabled();
  }

  await ask(0);
  await expect(form.getByText("Which project should be opened?")).toBeVisible();
  await expect(form.getByText("Project forms", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "mcp-form-pending");
  const submit = form.getByRole("button", { name: "Submit", exact: true });
  await submit.click();
  await expect(form.getByLabel(/Project name/)).toHaveAttribute("aria-invalid", "true");
  expect(await answers()).toEqual([]);
  await form.getByLabel(/Project name/).fill("UI fixture project");
  await form.getByLabel(/Include archived projects/).selectOption({ label: "No" });
  const sent = page.waitForRequest((request) => request.url().includes("/rpc/threads/answer"));
  await submit.click();
  const accepted = await sent;
  await expect
    .poll(answers)
    .toEqual([
      { action: "accept", content: { project: "UI fixture project", include_archived: false } },
    ]);
  await expect(form.getByLabel(/Project name/)).toHaveCount(0);
  const duplicate = await page.request.post("/rpc/threads/answer", {
    headers: { [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL_VERSION) },
    data: accepted.postDataJSON(),
  });
  expect(duplicate.status()).toBe(409);
  await expect(finished).toHaveCount(1);

  for (const [index, button, action] of [
    [1, "Decline", "decline"],
    [2, "Cancel", "cancel"],
  ] as const) {
    await ask(index);
    await form.getByRole("button", { name: button, exact: true }).click();
    await expect.poll(async () => (await answers()).at(-1)).toEqual({ action });
    await expect(finished).toHaveCount(index + 1);
  }
  expect(await answers()).toHaveLength(3);
});
