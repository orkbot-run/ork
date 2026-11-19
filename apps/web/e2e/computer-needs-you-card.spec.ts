// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved. Native renderer entry selection is an Ork addition.

import type { Page, Route } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";
import { expect, test } from "./renderer-test";

test("needs-you computer card opens a group member bot computer", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `needs-you-group-${stamp}@orkbot.test`, "password12", "Needs You Group");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const writerId = await createNamedBot(page, "Writer");
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Needs you team",
    botIds: [chiefId, writerId],
  });

  await mockGroupComputerCard(page, group.id, writerId);
  await mockMemberComputerRpcs(page, writerId);

  await page.goto(`/app/g/${group.id}`);
  await expect(page.getByRole("combobox", { name: /Message Needs you team/ })).toBeVisible();

  const card = page.getByTestId("computer-card");
  await expect(card).toBeVisible();
  await expect(card.getByText("Computer", { exact: true })).toBeVisible();
  await expect(card.getByText("Needs you", { exact: true })).toBeVisible();
  const open = card.getByTestId("computer-card-open");
  await expect(open).toBeVisible();
  await expect(open).toHaveText("Take control");
  await expect(card.getByRole("button")).toHaveCount(1);
  await captureScreenshot(page, testInfo, "computer-needs-you-card-group");

  await open.click();
  await expect(page).toHaveURL(new RegExp(`/app/g/${group.id}`));
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await expect(page.getByTestId("computer-viewport")).toBeVisible();
  await expectSidebarEdgeClickReachesComputer(page);
  await captureScreenshot(page, testInfo, "computer-needs-you-card-group-open");
});

test("group takeover preview and replies stay bound to the requested run", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `takeover-actions-${stamp}@orkbot.test`, "password12", "Takeover Actions");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const botId = await createNamedBot(page, "Tester");
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Takeover test",
    botIds: [chiefId, botId],
  });

  const messageId = "msg-needs-you-computer";
  let runId = "waiting-done";
  let closed = false;
  let previewRequests = 0;
  let refreshed = false;
  await mockGroupComputerCard(page, group.id, botId, () => {
    if (closed) refreshed = true;
    return runId;
  });
  await page.route("**/rpc/computer/takeoverPreview", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ json: { botId, runId, messageId } });
    previewRequests++;
    if (runId === "waiting-forbidden") {
      await route.fulfill({
        status: 403,
        json: { json: { defined: false, code: "FORBIDDEN", status: 403, message: "Forbidden" } },
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: {
        json: {
          id: "b".repeat(64),
          mimeType: "image/png",
          capturedAt: new Date().toISOString(),
          width: 1,
          height: 1,
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=",
        },
      },
    });
  });
  await page.route("**/rpc/computer/release", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      json: { botId, runId, messageId, reason: runId.endsWith("done") ? "done" : "skipped" },
    });
    if (runId === "waiting-stale") {
      await route.fulfill({
        status: 409,
        json: { json: { defined: false, code: "CONFLICT", status: 409, message: "Stale run" } },
      });
      return;
    }
    closed = true;
    await route.fulfill({ json: { json: { ok: true, resolved: true } } });
  });

  for (const [id, action, status] of [
    ["waiting-done", "Done", "Done"],
    ["waiting-skip", "Skip", "Skipped"],
    ["waiting-stale", "Skip", null],
  ] as const) {
    runId = id;
    closed = false;
    refreshed = false;
    const previous = previewRequests;
    await page.goto(`/app/g/${group.id}`);
    const card = page.getByTestId("computer-card");
    const preview = card.getByRole("img", { name: "Computer screen preview" });
    await expect(preview).toBeVisible();
    expect(previewRequests - previous).toBe(1);
    if (id === "waiting-done")
      await captureScreenshot(page, testInfo, "computer-card-with-preview");
    await card.getByRole("button", { name: action, exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(card.getByRole("button")).toHaveCount(0);
    if (status) {
      await expect.poll(() => refreshed).toBe(true);
      await expect(card.getByText("Sign in to continue.")).toBeHidden();
      await card.locator("summary").filter({ hasText: status }).click();
      await expect(card.getByText("Sign in to continue.")).toBeVisible();
    } else {
      await expect(card.getByRole("alert")).toHaveText(
        "This computer request is no longer waiting",
      );
    }
  }
  runId = "waiting-forbidden";
  await page.goto(`/app/g/${group.id}`);
  const forbidden = page.getByTestId("computer-card");
  await expect(forbidden.getByRole("alert")).toHaveText(
    "You do not have access to this computer request",
  );
  await expect(forbidden.getByRole("button")).toHaveCount(0);
  runId = "waiting-control";
  await mockMemberComputerRpcs(page, botId, { runId, messageId });
  await page.goto(`/app/g/${group.id}`);
  await page.getByTestId("computer-card").getByRole("button", { name: "Take control" }).click();
  await expect(page.getByTestId("computer-viewport")).toBeVisible();
});

// The expanded bots sidebar's resize edge sits at x = 308-316px; the computer covers it.
async function expectSidebarEdgeClickReachesComputer(page: Page) {
  const sidebar = page.getByTestId("bots-sidebar");
  await expect(sidebar).not.toHaveAttribute("data-collapsed", "true");
  await expect(page.getByTestId("bots-sidebar-edge")).toHaveCount(0);
  const point = { x: 312, y: Math.round((page.viewportSize()?.height ?? 720) / 2) };
  const hitsComputer = await page.evaluate(
    ({ x, y }) =>
      Boolean(document.elementFromPoint(x, y)?.closest('[data-testid="computer-viewport"]')),
    point,
  );
  expect(hitsComputer).toBe(true);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId("computer-viewport")).toBeVisible();
  await expect(sidebar).not.toHaveAttribute("data-collapsed", "true");
}

async function mockGroupComputerCard(
  page: Page,
  groupId: string,
  botId: string,
  runId?: () => string,
) {
  await page.route("**/rpc/threads/get", async (route) => {
    const post = route.request().postData() ?? "";
    if (!post.includes(groupId)) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const parsed = (await response.json()) as {
      json?: { threadId: string; cursor: number; messages?: Array<{ id?: string }> };
    };
    const snap = parsed.json;
    if (!snap) {
      await route.fulfill({ response });
      return;
    }
    const messages = snap.messages ?? [];
    if (messages.some((message) => message.id === "msg-needs-you-computer")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ json: snap }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          ...snap,
          messages: [
            ...messages,
            {
              id: "msg-needs-you-computer",
              threadId: snap.threadId,
              seq: Math.max(snap.cursor, 0) + 1,
              role: "bot",
              botId,
              runId: runId?.(),
              blocks: [{ kind: "computer", state: "Needs you", text: "Sign in to continue." }],
              createdAt: new Date().toISOString(),
            },
          ],
        },
      }),
    });
  });
}

async function mockMemberComputerRpcs(
  page: Page,
  botId: string,
  expectedTakeover?: { runId: string; messageId: string },
) {
  const status = {
    botId,
    mode: "team",
    kind: "fake",
    state: "running",
    controlHolder: "user",
    controlBotId: botId,
    takeoverRequested: true,
    screenAvailable: true,
    screenWidth: 1024,
    screenHeight: 768,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
  };
  const computerJson = JSON.stringify({ json: status });
  const fulfillForBot = async (route: Route, body: string) => {
    expect(route.request().postDataJSON()).toMatchObject({ json: { botId } });
    await route.fulfill({ contentType: "application/json", body });
  };
  await page.route("**/rpc/computer/boot", async (route) => {
    await fulfillForBot(route, computerJson);
  });
  await page.route("**/rpc/computer/status", async (route) => {
    await fulfillForBot(route, computerJson);
  });
  await page.route("**/rpc/computer/takeover", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ json: { botId, ...expectedTakeover } });
    await fulfillForBot(
      route,
      JSON.stringify({
        json: {
          leaseId: "lease-needs-you",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    );
  });
  await page.route("**/rpc/computer/screenUrl", async (route) => {
    await fulfillForBot(route, JSON.stringify({ json: { url: null } }));
  });
  await page.route("**/rpc/computer/heartbeat", async (route) => {
    await fulfillForBot(route, JSON.stringify({ json: { ok: true } }));
  });
}
