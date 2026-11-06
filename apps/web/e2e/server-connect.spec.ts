// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createServerConnectLink } from "@orkbot/contracts";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

for (const path of ["/", "/sign-in", "/app", "/onboarding"]) {
  test(`browser ${path} offers pairing and the native server handoff`, async ({
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
    await expect(page.getByRole("heading", { name: "Ork", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open in Ork", exact: true })).toHaveAttribute(
      "href",
      createServerConnectLink(new URL(page.url()).origin),
    );
    await expect(page.getByRole("textbox", { name: "Pairing key", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Initialize", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: /sign in|continue|get started/i })).toHaveCount(
      0,
    );
    expect(productRequests).toEqual([]);
    expect(errors).toEqual([]);
    if (path === "/") await captureScreenshot(page, testInfo, "native-server-handoff");
  });
}

test("browser callback can finish without opening product screens", async ({ page }) => {
  await page.goto("/integrations/callback");
  await expect(page.getByText("You can close this window.")).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("browser initialization waits for native approval and recovers a lost status response", async ({
  page,
}, testInfo) => {
  await page.route("**/api/auth/native/pair", (route) =>
    route.fulfill({
      status: 202,
      json: { pending: true, pairingId: "p".repeat(43) },
    }),
  );
  let polls = 0;
  await page.route("**/api/auth/native/pair/status", (route) => {
    expect(route.request().postDataJSON()).toEqual({ pairingId: "p".repeat(43) });
    return ++polls === 1 ? route.abort("failed") : route.fulfill({ json: { paired: true } });
  });
  await page.goto("/");
  await page.getByRole("textbox", { name: "Pairing key", exact: true }).fill("abc-234");
  await page.getByRole("button", { name: "Initialize", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Confirm the server in Ork.");
  await expect(page.getByRole("button", { name: "Initialize", exact: true })).toBeDisabled();
  await captureScreenshot(page, testInfo, "server-initialization-approval");
  await expect(page.getByRole("status")).toHaveText("Initialized");
  expect(polls).toBe(2);
  expect(await page.context().cookies()).toEqual([]);
});
