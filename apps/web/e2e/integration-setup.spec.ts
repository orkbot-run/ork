// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved. Native renderer entry selection is an Ork addition.

import { captureScreenshot, completeOnboarding, signup } from "./helpers";
// Modified by Ork contributors: canonical domain links now use ork.run.
import { expect, test } from "./renderer-test";

test("ordinary accounts can add personal MCP connections without server setup", async ({
  page,
}, testInfo) => {
  await signup(page, `personal-mcp-${Date.now()}@orkbot.test`, "password12", "Personal MCP");
  await completeOnboarding(page);
  await page.goto("/integrations/setup");
  await expect(page.getByRole("heading", { name: "Add MCP server" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search apps", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Server integrations" })).toBeHidden();
  for (const name of ["Composio", "Pipedream", "Executor"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeHidden();
  }
  await page.route("**/rpc/capabilities/catalogSearch", (route) =>
    route.fulfill({
      json: {
        json: {
          enabled: true,
          results: [
            {
              domain: "notion.example.test",
              name: "Notion",
              description: "",
              pageUrl: null,
              surfaces: [
                {
                  kind: "mcp",
                  slug: "notion",
                  source: "https://mcp.notion.example.test/mcp",
                  auth: null,
                },
              ],
            },
          ],
        },
      },
    }),
  );
  const message = "The sign-in address does not match this server's configuration.";
  await page.route("**/rpc/mcp/oauth/begin", (route) =>
    route.fulfill({
      status: 400,
      json: { json: { defined: false, code: "MCP_OAUTH_REDIRECT_MISMATCH", status: 400, message } },
    }),
  );
  await page.getByRole("textbox", { name: "Search apps", exact: true }).fill("Notion");
  await page.getByRole("button", { name: "Search integrations.sh", exact: true }).click();
  await expect(page.getByText("Notion", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(message);
  await expect(page.getByRole("link", { name: "Troubleshoot", exact: true })).toHaveAttribute(
    "href",
    "https://ork.run/docs/troubleshooting/#mcp-oauth-redirect-mismatch",
  );
  await captureScreenshot(page, testInfo, "personal-mcp-callback-mismatch");
  await page.route("**/rpc/mcp/oauth/begin", (route) =>
    route.fulfill({ json: { json: { status: "already_connected" } } }),
  );
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connected", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "personal-mcp-without-server-admin");
});
