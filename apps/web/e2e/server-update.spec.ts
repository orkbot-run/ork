// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { ServerUpdatesStatus } from "@orkbot/contracts";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";
import { expect, test } from "./renderer-test";

test("server updates require an explicit request and automatic updates are opt-in", async ({
  page,
}, testInfo) => {
  let state: ServerUpdatesStatus = {
    available: true,
    mode: "manual",
    channel: "preview",
    currentRevision: "a".repeat(40),
    candidate: null,
    lastCheckedAt: null,
    policyRevision: 0,
    lastRequest: null,
    error: null,
  };
  await page.route(/\/rpc\/serverUpdates\/(status|check|apply|policy)(\?|$)/, async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    const body = route.request().postDataJSON()?.json;
    if (action === "check")
      state = {
        ...state,
        candidate: { revision: "b".repeat(40), version: "0.2.0" },
        lastCheckedAt: new Date().toISOString(),
      };
    if (action === "policy") {
      expect(body.expectedRevision).toBe(state.policyRevision);
      state = {
        ...state,
        mode: body.automatic ? "automatic" : "manual",
        policyRevision: state.policyRevision + 1,
      };
    }
    if (action === "apply") {
      expect(body.candidateRevision).toBe(state.candidate?.revision);
      expect(body.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
      state = {
        ...state,
        lastRequest: {
          id: body.idempotencyKey,
          revision: body.candidateRevision,
          state: "requested",
          requestedAt: new Date().toISOString(),
        },
      };
    }
    await route.fulfill({ json: { json: state } });
  });
  await signup(page, `server-update-${randomUUID()}@orkbot.test`, "password12", "Server updates");
  await completeOnboarding(page);
  await openUserSettings(page, "updates");
  const panel = page.getByTestId("server-update-settings");
  await expect(panel.getByRole("switch", { name: "Automatic updates" })).not.toBeChecked();
  await panel.getByRole("button", { name: "Check for updates" }).click();
  await expect(panel.getByText("0.2.0", { exact: true })).toBeVisible();
  await panel.getByRole("switch", { name: "Automatic updates" }).click();
  await expect(panel.getByRole("switch", { name: "Automatic updates" })).toBeChecked();
  await panel.getByRole("button", { name: "Update server" }).click();
  await expect(panel.getByRole("status")).toHaveText("Deployment requested");
  await expect(panel.getByRole("button", { name: "Update server" })).toBeDisabled();
  await captureScreenshot(page, testInfo, "server-update-requested");
});
