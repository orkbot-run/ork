// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved. Native renderer entry selection is an Ork addition.

import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";
import { expect, test } from "./renderer-test";

test("organization vault shows secrets and server-specific workspace access", async ({
  page,
}, testInfo) => {
  await signup(page, `org-vault-${Date.now()}@orkbot.test`, "password12", "Vault Admin");
  await completeOnboarding(page);
  await page.route("**/rpc/models/workspacePolicy", (route) =>
    route.fulfill({ json: { json: { managed: true, canManage: false, policy: null } } }),
  );
  await page.route("**/rpc/organizationVault/context", (route) =>
    route.fulfill({ json: { json: { kind: "shared" } } }),
  );
  await page.route("**/rpc/organizationVault/list", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            name: "deploy-key",
            title: "Deployment key",
            note: "For production",
            origin: "",
            auth: { type: "command" },
            createdAt: "2026-11-01T12:00:00.000Z",
            updatedAt: "2026-11-01T12:00:00.000Z",
          },
        ],
      },
    }),
  );
  let allowed = false;
  await page.route("**/rpc/organizationVault/workspaces", (route) =>
    route.fulfill({
      json: {
        json: [
          { id: "workspace-1", name: "Production", state: "ready", granted: allowed },
          { id: "workspace-2", name: "Research", state: "ready", granted: false },
        ],
      },
    }),
  );
  await page.route("**/rpc/organizationVault/setWorkspaceAccess", (route) => {
    allowed = true;
    return route.fulfill({ json: { json: { ok: true } } });
  });
  const settings = await openUserSettings(page);
  await settings.getByRole("button", { name: "Organization settings", exact: true }).click();
  await settings.getByTestId("settings-nav-organization-vault").click();
  const vault = settings.getByTestId("organization-vault");
  await expect(vault.getByText("Deployment key")).toBeVisible();
  await expect(vault.getByText("Production")).toBeVisible();
  await captureScreenshot(page, testInfo, "organization-vault");
  await vault.getByRole("switch").first().click();
  await expect(vault.getByRole("switch").first()).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(vault.getByText("Deployment key")).toBeVisible();
  await captureScreenshot(page, testInfo, "organization-vault-mobile");
});

test("saves a contact, a card billed to it, and a login from Settings, showing no protected value", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `vault-${stamp}@orkbot.test`, "password12", "Vault Owner");
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "vault");
  const vault = settings.getByTestId("vault");
  const editor = page.getByTestId("vault-editor");

  async function startNew(kind: string) {
    await vault.getByTestId("vault-new").click();
    await page.getByTestId(`vault-new-${kind}`).click();
    await expect(editor).toBeVisible();
  }

  await startNew("contact");
  await editor.getByLabel("Label", { exact: true }).fill("Home");
  await editor.getByLabel("Full name", { exact: true }).fill("Alex Rivera");
  await editor.getByLabel("Address", { exact: true }).fill("12 Elm St");
  await editor.getByLabel("City", { exact: true }).fill("Springfield");
  await editor.getByLabel("ZIP or postal code", { exact: true }).fill("12345");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);

  await startNew("card");
  await editor.getByLabel("Card number", { exact: true }).fill("4242424242424242");
  await expect(editor.getByTestId("vault-card-brand")).toHaveText("Visa");
  await editor.getByLabel("Expiry", { exact: true }).fill("0830");
  await editor.getByLabel("Security code", { exact: true }).fill("123");
  await editor.getByLabel("Billing address", { exact: true }).selectOption({ label: "Home" });
  await editor.getByRole("button", { name: "Add a note", exact: true }).click();
  await editor.getByLabel("When to use", { exact: true }).fill("For travel");
  await captureScreenshot(page, testInfo, "vault-new-card");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);

  await startNew("login");
  await editor.getByLabel("Site", { exact: true }).fill("https://www.example.test");
  const values = editor.getByTestId("login-field").locator("input:not([aria-label='Label'])");
  await values.nth(0).fill(`fake-user-${stamp}@example.test`);
  await values.nth(1).fill(`fake-password-${stamp}`);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);

  const rows = vault.getByTestId("vault-credential-row");
  await expect(rows).toHaveCount(3);
  await expect(vault.getByText("Visa ·· 4242", { exact: true })).toBeVisible();
  await expect(vault.getByText("Expires 08/30 · For travel", { exact: true })).toBeVisible();
  await expect(vault.getByText("Home", { exact: true })).toBeVisible();
  await expect(vault.getByTestId("vault-filter-card")).toBeVisible();
  await captureScreenshot(page, testInfo, "vault-list");

  await vault.getByText("Visa ·· 4242", { exact: true }).click();
  const detail = page.getByTestId("vault-item-detail");
  await expect(detail.getByText("•••• 4242", { exact: true })).toBeVisible();
  await expect(detail.getByText("Home", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "vault-card-detail");
  // The item opens in the Settings panel itself, and Back returns to the list.
  await page.getByTestId("vault-back").click();
  await expect(rows).toHaveCount(3);

  const listed = JSON.stringify(await rpc(page, "vault/list", { scope: "account" }));
  expect(listed).not.toContain("4242424242424242");
  expect(listed).not.toContain(`fake-password-${stamp}`);
  await expect(page.getByText("4242424242424242")).toHaveCount(0);
});
