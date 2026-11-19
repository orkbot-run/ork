// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved. Native renderer entry selection is an Ork addition.

import { CLIENT_PROTOCOL_HEADER, CLIENT_PROTOCOL_VERSION } from "@orkbot/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, signup } from "./helpers";
import { expect, test } from "./renderer-test";

test("shows the Ork loading screen while the session is starting", async ({ page }, testInfo) => {
  let release = () => {};
  const session = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/auth/get-session**", async (route) => {
    await session;
    await route.fulfill({ json: null });
  });
  try {
    await page.goto("/app");
    const loading = page.locator('[data-orkbot-app-state="session-pending"]');
    await expect(loading.getByRole("status")).toHaveText("Loading…");
    await expect(loading.locator('img[src="/icon-192.png"]')).toBeVisible();
    await captureScreenshot(page, testInfo, "workspace-loading");
  } finally {
    release();
  }
});

test("workspace icons switch the roster and restore the previous chat without reloading", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `space-switch-${stamp}@orkbot.test`, "password12", "Space Switcher");
  await completeOnboarding(page);
  const firstBot = activeBotId(page);
  const otherSpace = await page.request.post("/rpc/spaces/create", {
    headers: { [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL_VERSION) },
    data: { json: { name: "Second space" } },
  });
  const { json: space } = (await otherSpace.json()) as { json: { id: string } };
  const created = await page.request.post("/rpc/bots/create", {
    headers: {
      [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL_VERSION),
      "x-orkbot-space-id": space.id,
    },
    data: {
      json: {
        name: "Scout",
        description: "",
        notifyOnFinish: true,
        computerMode: "team",
      },
    },
  });
  expect(created.ok()).toBe(true);
  const { json: scout } = (await created.json()) as { json: { id: string } };
  const createdTelescope = await page.request.post("/rpc/bots/create", {
    headers: {
      [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL_VERSION),
      "x-orkbot-space-id": space.id,
    },
    data: {
      json: { name: "Telescope", description: "", notifyOnFinish: true, computerMode: "team" },
    },
  });
  expect(createdTelescope.ok()).toBe(true);
  const { json: telescope } = (await createdTelescope.json()) as { json: { id: string } };
  await page.reload();
  const rail = page.getByRole("navigation", { name: "Workspaces" });
  const firstSpace = await rail.locator('[aria-current="true"]').getAttribute("aria-label");
  expect(firstSpace).toBeTruthy();
  const secondSpace = rail.getByRole("button", { name: "Second space" });
  await expect(secondSpace).toBeVisible();
  const railList = page.getByTestId("workspace-rail-list");
  expect(await railList.evaluate((list) => list.scrollWidth <= list.clientWidth)).toBe(true);
  await expect(page.getByTestId("bots-sidebar").getByRole("button", { name: /Scout/ })).toHaveCount(
    0,
  );

  // A reload would drop this marker; an in-place switch keeps it. The observer
  // records any moment the sidebar lost its bots while the screen was not being
  // held by the switch's transition, which is the blank flash people see.
  await page.evaluate(() => {
    const w = window as unknown as { spaceSwitchMarker?: boolean; visibleBlanks?: number };
    w.spaceSwitchMarker = true;
    w.visibleBlanks = 0;
    new MutationObserver(() => {
      const sidebar = document.querySelector('[data-testid="bots-sidebar"]');
      const held = document.documentElement.classList.contains("rk-space-switching");
      const hasRoster =
        sidebar?.textContent?.includes("Scout") || sidebar?.textContent?.includes("Chief");
      if (!hasRoster && !held) w.visibleBlanks! += 1;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await secondSpace.click();
  await page.waitForURL(`**/app/${scout.id}`);
  await expect(page.getByPlaceholder("Message Scout")).toBeVisible();
  await expect(secondSpace).toHaveAttribute("aria-current", "true");
  await expect(
    page.getByTestId("bots-sidebar").getByRole("button", { name: /^Chief/ }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { spaceSwitchMarker?: boolean }).spaceSwitchMarker,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => (window as unknown as { visibleBlanks?: number }).visibleBlanks),
  ).toBe(0);
  expect(await page.evaluate(() => window.localStorage.getItem("orkbot:space-id"))).toBe(space.id);
  await page.mouse.move(500, 90);
  await captureScreenshot(page, testInfo, "space-switch-in-place");
  await page.locator(`[data-roster-bot-id="${telescope.id}"]`).click();
  await page.waitForURL(`**/app/${telescope.id}`);
  await expect(page.getByPlaceholder("Message Telescope")).toBeVisible();
  await rail.getByRole("button", { name: firstSpace!, exact: true }).click();
  await page.waitForURL(`**/app/${firstBot}`);
  await expect(page.getByTestId("bots-sidebar").getByRole("button", { name: /Scout/ })).toHaveCount(
    0,
  );
  await secondSpace.click();
  await page.waitForURL(`**/app/${telescope.id}`);
  await expect(page.getByPlaceholder("Message Telescope")).toBeVisible();
});

test("workspace drafts retain their own file bytes after switching and reopening the renderer", async ({
  page,
}, testInfo) => {
  await signup(page, `draft-switch-${Date.now()}@orkbot.test`, "password12", "Draft Switcher");
  await completeOnboarding(page);
  const firstBot = activeBotId(page);
  const firstDraft = "Unsent workspace A draft";
  await page.getByRole("combobox", { name: /Message/ }).fill(firstDraft);
  await page.locator('input[type="file"]').setInputFiles({
    name: "workspace-a.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Workspace A file bytes"),
  });
  await expect(
    page.getByRole("button", { name: "Remove workspace-a.txt", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Remove workspace-a.txt", exact: true }),
  ).toBeVisible();
  const headers = { [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL_VERSION) };
  const response = await page.request.post("/rpc/spaces/create", {
    headers,
    data: { json: { name: "Draft B" } },
  });
  const { json: space } = (await response.json()) as { json: { id: string } };
  const created = await page.request.post("/rpc/bots/create", {
    headers: { ...headers, "x-orkbot-space-id": space.id },
    data: { json: { name: "Scout", description: "", notifyOnFinish: true, computerMode: "team" } },
  });
  expect(created.ok()).toBe(true);
  const { json: scout } = (await created.json()) as { json: { id: string } };
  await page.goto(`/app/${scout.id}`);
  const composer = page.getByRole("combobox", { name: /Message/ });
  await expect(composer).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Remove workspace-a.txt", exact: true }),
  ).toHaveCount(0);
  await composer.fill("Unsent workspace B draft");
  await page.goto(`/app/${firstBot}`);
  await expect(composer).toHaveValue(firstDraft);
  await expect(
    page.getByRole("button", { name: "Remove workspace-a.txt", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(composer).toHaveValue(firstDraft);
  await expect(
    page.getByRole("button", { name: "Remove workspace-a.txt", exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "workspace-draft-file-restored");
  const uploaded: string[] = [];
  await page.route("**/rpc/artifacts/create", async (route) => {
    uploaded.push(route.request().postDataJSON().json.contentBase64);
    await route.continue();
  });
  await composer.press("Enter");
  await expect(page.getByTestId("transcript").getByText(firstDraft, { exact: true })).toBeVisible();
  expect(uploaded).toEqual([Buffer.from("Workspace A file bytes").toString("base64")]);
  await page.goto(`/app/${scout.id}`);
  await expect(composer).toHaveValue("Unsent workspace B draft");
  await expect(
    page.getByRole("button", { name: "Remove workspace-a.txt", exact: true }),
  ).toHaveCount(0);
});
