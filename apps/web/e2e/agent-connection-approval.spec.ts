// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved. Native renderer entry selection is an Ork addition.

import { captureScreenshot } from "./helpers";
import { expect, test } from "./renderer-test";

for (const decision of ["approve", "decline"] as const) {
  test(`connection card identifies the requester and ${decision} decision`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/e2e/fixtures/agent-connection-approval.html?decision=${decision}`);
    await expect(
      page.getByText(
        `${decision === "approve" ? "Approve" : "Decline"} connection with “Helper”?`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByText("iMessage: +15551234567", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Always allow this tool", exact: true }),
    ).toHaveCount(0);
    await captureScreenshot(page, testInfo, `agent-connection-${decision}-card`);
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(page.getByText("Denied", { exact: true })).toBeVisible();
  });
}
