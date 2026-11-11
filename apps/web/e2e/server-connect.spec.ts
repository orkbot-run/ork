// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/native/workspace-status", (route) =>
    route.fulfill({ json: { status: "unconnected" } }),
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
    await expect(page.getByRole("heading", { name: "Your Ork server is ready" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Pairing key", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Connect a workspace" })).toHaveAttribute(
      "href",
      "https://app.ork.run",
    );
    await expect(page.getByRole("heading", { name: "Find the link or code" })).toHaveCount(0);
    expect([...new Set(productRequests)]).toEqual(["/api/auth/native/workspace-status"]);
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
  await page.route("**/api/auth/native/workspace-status", (route) =>
    route.fulfill({ json: { status: "unknown" } }),
  );
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Responding");
  await expect(
    page.getByText("Check the workspace connection status", { exact: false }).first(),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Pairing key" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "initialized-server-handoff");
  expect(await page.context().cookies()).toEqual([]);
});

test("workspace instructions remain usable on mobile", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Connect a workspace" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await captureScreenshot(page, testInfo, "server-connect-mobile");
});

test("confirmed workspace connection offers native app and dashboard", async ({ page }) => {
  await page.route("**/api/auth/native/workspace-status", (route) =>
    route.fulfill({ json: { status: "connected" } }),
  );
  await page.goto("/");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open in Ork" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to dashboard" })).toHaveAttribute(
    "href",
    "https://app.ork.run",
  );
});
