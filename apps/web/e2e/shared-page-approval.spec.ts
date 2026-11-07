// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { expect, test } from "./renderer-test";

const source = (text: string) =>
  `export default function App() { return <Page title="Shared plan"><Text>${text}</Text></Page>; }`;

test("a shared page changes only after approval of its current version and link", async ({
  page,
}, testInfo) => {
  await signup(page, `shared-page-${Date.now()}@orkbot.test`, "password12", "Page Owner");
  await completeOnboarding(page);
  const send = async (args: Record<string, unknown>) => {
    const composer = page.getByRole("combobox", { name: /^Message/ });
    await composer.fill(`call save_page with ${JSON.stringify(args)}`);
    await composer.press("Enter");
  };
  await send({ title: "Shared plan", source: source("Original") });
  const card = page.getByTestId("page-card");
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await card.getByRole("button", { name: "Open Shared plan" }).click();
  const pageId = new URL(page.url()).searchParams.get("page")!;
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("page-view")).toBeHidden();
  await rpc(page, "pages/setVisibility", { pageId, visibility: "link" });
  await rpc(page, "autoReview/set", { mode: "never" });
  await rpc(page, "approvalRules/set", {
    effect: "always_allow",
    matchKind: "tool",
    matchValue: "save_page",
  });
  await send({ pageId, source: source("Approved revision") });
  const allow = page.getByRole("button", { name: "Allow once", exact: true });
  await expect(allow).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Update shared page “Shared plan”?", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Always allow this tool", exact: true }),
  ).toHaveCount(0);
  expect(await rpc(page, "pages/get", { pageId })).toMatchObject({ currentVersion: 1 });
  await captureScreenshot(page, testInfo, "shared-page-approval");
  await allow.click();
  await expect
    .poll(
      async () =>
        (await rpc<{ currentVersion: number }>(page, "pages/get", { pageId })).currentVersion,
    )
    .toBe(2);

  await rpc(page, "autoReview/set", { mode: "auto" });
  await send({ pageId, source: source("Stale revision") });
  await expect(allow).toBeVisible({ timeout: 30_000 });
  await rpc(page, "pages/setVisibility", { pageId, visibility: "private" });
  await allow.click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
  expect(await rpc(page, "pages/get", { pageId })).toMatchObject({
    currentVersion: 2,
    visibility: "private",
  });
});
