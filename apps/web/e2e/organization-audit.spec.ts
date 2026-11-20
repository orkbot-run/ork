// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { readFile } from "node:fs/promises";
import type { AuditEvent, OrganizationList } from "@orkbot/contracts";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";
import { expect, test } from "./renderer-test";

test("opens the organization's activity, loads older events and exports only that organization", async ({
  page,
}, testInfo) => {
  const email = `audit-owner-${Date.now()}@orkbot.test`;
  await signup(page, email, "password12", "Audit Owner");
  await completeOnboarding(page);
  const { activeOrganizationId } = await rpc<OrganizationList>(page, "organizations/list", {});
  expect(activeOrganizationId).toBeTruthy();
  const other = await rpc<{ id: string; defaultSpaceId: string }>(page, "organizations/create", {
    name: "Unrelated organization",
  });
  for (let index = 0; index < 27; index++) {
    await rpc(page, "organizations/rename", {
      organizationId: activeOrganizationId,
      name: `Audit rename ${index}`,
    });
  }

  const settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-organization").click();
  await settings.getByRole("button", { name: "Organization options" }).click();
  await page.getByRole("menuitem", { name: "Activity log" }).click();
  await expect(settings.getByRole("heading", { name: "Activity log", exact: true })).toBeVisible();
  const log = settings.getByTestId("audit-log");
  const events = log.getByTestId("audit-event");
  await expect(events).toHaveCount(25);
  await expect(events.first()).toContainText("Audit rename 26");
  await expect(events.first()).toContainText(email);
  await expect(events.first()).toContainText("organization.renamed");
  await expect(events.first()).toContainText("Success");
  await expect(events.first().locator("time")).toHaveAttribute("datetime", /^\d{4}-/);
  await captureScreenshot(page, testInfo, "organization-activity-log");
  await log.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(events.filter({ hasText: "Audit rename 0" })).toHaveCount(1);
  await expect(events.first()).toContainText("Audit rename 26");
  await expect(events.filter({ hasText: "Unrelated organization" })).toHaveCount(0);

  const exportButton = log.getByRole("button", { name: "Export", exact: true });
  await page.route("**/api/audit-events/export", (route) => route.fulfill({ status: 503 }));
  await exportButton.click();
  await expect(log.getByRole("alert")).toHaveText("Could not export activity log. Try again.");
  await page.unroute("**/api/audit-events/export");

  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^orkbot-audit-log-\d{4}-\d{2}-\d{2}\.jsonl$/);
  const text = await readFile((await download.path())!, "utf8");
  const rows = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as AuditEvent);
  expect(rows.filter((row) => row.action === "organization.renamed")).toHaveLength(27);
  expect(new Set(rows.map((row) => row.organizationId))).toEqual(new Set([activeOrganizationId]));
  expect(text).not.toContain(other.id);
  await expect(log.getByRole("alert")).toHaveCount(0);

  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 480, height: 900 });
  await expect(events.first()).toBeVisible();
  expect(await log.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "organization-activity-log-narrow");
  if (desktopViewport) await page.setViewportSize(desktopViewport);

  await settings.getByRole("button", { name: "Close user settings" }).click();
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Unrelated organization", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("orkbot:space-id")))
    .toBe(other.defaultSpaceId);
  await completeOnboarding(page);
  const otherSettings = await openUserSettings(page);
  await otherSettings.getByTestId("settings-nav-organization").click();
  await otherSettings.getByRole("button", { name: "Organization options" }).click();
  await page.getByRole("menuitem", { name: "Activity log" }).click();
  const otherLog = otherSettings.getByTestId("audit-log");
  await expect(
    otherLog.getByTestId("audit-event").filter({
      hasText: "Unrelated organization",
    }),
  ).toHaveCount(1);
  await expect(otherLog.getByText("Audit rename 26", { exact: true })).toHaveCount(0);
  const otherDownloadPromise = page.waitForEvent("download");
  await otherLog.getByRole("button", { name: "Export", exact: true }).click();
  const otherDownload = await otherDownloadPromise;
  const otherText = await readFile((await otherDownload.path())!, "utf8");
  const otherRows = otherText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as AuditEvent);
  expect(new Set(otherRows.map((row) => row.organizationId))).toEqual(new Set([other.id]));
});

test("allows retry after a load failure and hides the activity log when the server refuses access", async ({
  page,
}) => {
  await signup(page, `audit-access-${Date.now()}@orkbot.test`, "password12", "Audit Access");
  await completeOnboarding(page);
  const auditUrl = `${new URL(page.url()).pathname}?settings=organization-activity`;
  let blocked = false;
  let healthy = false;
  await page.route("**/rpc/audit/events", (route) => {
    if (healthy && !blocked) return route.fallback();
    const status = blocked ? 403 : 503;
    return route.fulfill({
      status,
      json: {
        json: {
          defined: false,
          code: blocked ? "FORBIDDEN" : "SERVICE_UNAVAILABLE",
          status,
          message: blocked ? "Forbidden" : "Temporarily unavailable",
        },
      },
    });
  });
  await page.goto(auditUrl);
  const log = page.getByTestId("audit-log");
  await expect(log.getByRole("alert")).toContainText("Could not load activity log");
  healthy = true;
  await log.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(log.getByRole("alert")).toHaveCount(0);
  await expect(log.getByText("Loading activity log…")).toHaveCount(0);

  blocked = true;
  await page.goto(auditUrl);
  await expect(page).toHaveURL((url) => url.searchParams.get("settings") === "organization");
  await expect(log).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Organization options" })).toHaveCount(0);
});
