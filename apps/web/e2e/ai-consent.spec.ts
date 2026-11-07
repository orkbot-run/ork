// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { captureScreenshot, completeOnboarding, signup } from "./helpers";
import { expect, test } from "./renderer-test";

test("AI disclosure preserves the draft on refusal and sends after every reviewed recipient is allowed", async ({
  page,
}, testInfo) => {
  await signup(page, `consent-${Date.now()}@orkbot.test`, "password12", "Consent fixture");
  await completeOnboarding(page);
  const allowed = new Set<string>();
  const grants: unknown[] = [];
  let sends = 0;
  await page.route("**/rpc/aiConsent/status", (route) =>
    route.fulfill({
      json: {
        json: {
          scope: "fixture-scope",
          version: "fixture-version",
          recipients: [
            {
              key: "chat",
              name: "Chat connection",
              use: "model",
              detail: "Conversation model",
              allowed: allowed.has("chat"),
            },
            {
              key: "routine",
              name: "Routine connection",
              use: "model",
              detail: "Routine model",
              allowed: allowed.has("routine"),
            },
          ],
        },
      },
    }),
  );
  await page.route("**/rpc/aiConsent/allow", (route) => {
    const input = route.request().postDataJSON().json;
    grants.push(input);
    for (const key of input.keys) allowed.add(key);
    return route.fulfill({ json: { json: {} } });
  });
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/threads/send")) sends += 1;
  });
  const composer = page.getByRole("combobox", { name: /Message/ });
  await composer.fill("Draft awaiting permission");
  await composer.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(
    dialog.getByRole("heading", { name: "Share data with Chat connection?" }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "ai-data-sharing-consent");
  await dialog.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(composer).toHaveValue("Draft awaiting permission");
  expect(sends).toBe(0);
  expect(grants).toEqual([]);

  await composer.press("Enter");
  await expect(
    dialog.getByRole("heading", { name: "Share data with Chat connection?" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Share data with Routine connection?" }),
  ).toBeVisible();
  expect(sends).toBe(0);
  await dialog.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(composer).toHaveValue("");
  await expect.poll(() => sends).toBe(1);
  expect(grants).toHaveLength(2);
  for (const grant of grants)
    expect(grant).toMatchObject({ scope: "fixture-scope", version: "fixture-version" });
});
