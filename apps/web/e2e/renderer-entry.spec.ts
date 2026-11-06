// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, test } from "./renderer-test";

test("native renderer keeps Accounts sign-in available without a browser product entry", async ({
  page,
}) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: {
        passwordAuth: false,
        passwordReset: false,
        resetUrl: null,
        sso: { name: "Accounts", availability: "available" },
      },
    }),
  );
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Welcome to Ork" })).toBeVisible();
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue with Accounts", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open in Ork", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => Boolean(window.orkbotDesktop))).toBe(false);
});
