// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createServerConnectLink } from "@orkbot/contracts";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/native/initialization", (route) =>
    route.fulfill({ json: { required: true } }),
  );
});

for (const path of ["/", "/sign-in", "/app", "/onboarding"]) {
  test(`browser ${path} explains workspace setup and offers the native server handoff`, async ({
    page,
  }, testInfo) => {
    const productRequests: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith("/api/") || pathname.startsWith("/rpc/"))
        productRequests.push(pathname);
    });
    await page.goto(`${path}?server=https://other.example.test&native=true`);
    await expect(page.getByRole("heading", { name: "Your Ork. Your workspace." })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open in Ork", exact: true })).toHaveAttribute(
      "href",
      createServerConnectLink(new URL(page.url()).origin),
    );
    await expect(page.getByRole("textbox", { name: "Pairing key", exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Connect your server to a workspace" }),
    ).toBeVisible();
    await expect(
      page.getByText("node /app/apps/api/dist/cli/server-claim.js", { exact: true }),
    ).toBeVisible();
    expect([...new Set(productRequests)]).toEqual(["/api/auth/native/initialization"]);
    expect(errors).toEqual([]);
    if (path === "/") await captureScreenshot(page, testInfo, "native-server-handoff");
  });
}

test("browser callback can finish without opening product screens", async ({ page }) => {
  await page.goto("/integrations/callback");
  await expect(page.getByText("You can close this window.")).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("server response does not claim that a workspace is connected", async ({ page }, testInfo) => {
  await page.route("**/api/auth/native/initialization", (route) =>
    route.fulfill({ json: { required: false } }),
  );
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Responding");
  await expect(
    page.getByText("A server response does not confirm a workspace connection.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Pairing key" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "initialized-server-handoff");
  expect(await page.context().cookies()).toEqual([]);
});

test("workspace instructions remain usable on mobile", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Connect your server to a workspace" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open in Ork" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await captureScreenshot(page, testInfo, "server-connect-mobile");
});
