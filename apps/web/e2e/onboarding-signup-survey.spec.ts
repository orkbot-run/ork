// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved. Native renderer entry selection is an Ork addition.

import { signup } from "./helpers";
import { expect, test } from "./renderer-test";

test("a legacy survey flag does not interrupt onboarding", async ({ page }) => {
  // Older servers may still report the survey flag.
  await page.route("**/rpc/me", async (route) => {
    try {
      const response = await route.fetch();
      const body = (await response.json()) as { json: Record<string, unknown> };
      await route.fulfill({ response, json: { json: { ...body.json, needsSignupSurvey: true } } });
    } catch (error) {
      // Navigation or browser teardown can cancel a setup check after the test finishes.
      if (
        error instanceof Error &&
        /Response has been disposed|Route is already handled|Target .*closed/.test(error.message)
      )
        return;
      throw error;
    }
  });
  await signup(page, `survey-${Date.now()}@orkbot.test`, "password12", "Survey");
  await page.waitForURL(/\/app\//, { timeout: 20_000 });
  await expect(page.getByRole("combobox", { name: "How big is your team?" })).toHaveCount(0);
});
