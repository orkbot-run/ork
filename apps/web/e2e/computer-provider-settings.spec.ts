// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved. Native renderer entry selection is an Ork addition.

import { randomUUID } from "node:crypto";
import type { Route } from "@playwright/test";
import { computerProviderDescriptors } from "../../../packages/adapters/src/fake-computer-settings.test-support";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";
import { expect, test } from "./renderer-test";

async function adminComputers(route: Route) {
  const response = await route.fetch();
  const body = (await response.json()) as { json?: Record<string, unknown> };
  const me = (body.json?.me ?? body.json) as Record<string, unknown> | undefined;
  if (me) {
    me.sandboxProvider = "docker";
    me.isAdmin = true;
  }
  await route.fulfill({ response, json: body });
}

test("an admin selects a computer provider and sees its fields", async ({ page }, testInfo) => {
  await signup(
    page,
    `computer-settings-${randomUUID()}@orkbot.test`,
    "password12",
    "Computer settings",
  );
  await completeOnboarding(page);
  await page.route("**/rpc/me", adminComputers);
  await page.route("**/rpc/bootstrap", adminComputers);
  await page.route(/\/rpc\/computerProvider\/get(\?|$)/, (route) =>
    route.fulfill({
      json: {
        json: {
          provider: "default",
          defaultProvider: "docker",
          providers: computerProviderDescriptors(),
          values: {},
          savedSecrets: {},
        },
      },
    }),
  );
  await page.reload();
  const settings = await openUserSettings(page, "computer");
  const form = settings.getByTestId("computer-provider-settings");
  await form.getByLabel("New computers run on").selectOption("desktop");
  await form.getByLabel("Desktop ID").fill("ecd-example");
  await form.getByLabel("End user ID").fill("example-user");
  await form.getByLabel("Region").fill("cn-hangzhou");
  await form.getByLabel("Gateway URL").fill("https://gateway.example.com/mcp");
  await expect(form.getByLabel("Access key secret")).toHaveAttribute("type", "password");
  await captureScreenshot(page, testInfo, "computer-provider-settings");
  await form.getByLabel("New computers run on").selectOption("test-cloud");
  await expect(form.getByLabel("API key")).toBeVisible();
  await expect(form.getByLabel("Desktop ID")).toHaveCount(0);
});
