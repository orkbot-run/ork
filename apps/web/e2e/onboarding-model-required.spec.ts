// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved. Native renderer entry selection is an Ork addition.

import type { RpcOutput } from "@orkbot/contracts";
import { captureScreenshot, signup } from "./helpers";
import { expect, test } from "./renderer-test";

test.afterEach(async ({ page }) => {
  // Not "wait": a handler whose fulfill() lost a race to the route teardown never settles,
  // and "wait" would then hang the test to its timeout.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("onboarding cannot continue with an empty or failed model catalog", async ({ page }) => {
  let unavailable: "empty" | "failed" = "empty";
  await page.route("**/rpc/me", async (route) => {
    // The reload below can cancel a profile read at any point while it is being rewritten.
    try {
      const response = await route.fetch();
      const body = (await response.json()) as { json: Record<string, unknown> };
      await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
    } catch {
      await route.abort().catch(() => {});
    }
  });
  await page.route("**/rpc/models/list", (route) =>
    unavailable === "failed" ? route.abort() : route.fulfill({ json: { json: [] } }),
  );
  const stamp = Date.now();
  await signup(page, `catalog-${stamp}@orkbot.test`, "password12", "Model setup");

  for (const next of ["empty", "failed"] as const) {
    if (next === "failed") {
      unavailable = next;
      await page.reload();
    }
    await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    await expect(page.getByRole("heading", { name: "Create your first bot" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Message Chief" })).toHaveCount(0);
  }
});

test("Ollama Cloud onboarding requires a key before continuing", async ({ page }) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
  });
  const stamp = Date.now();
  await signup(page, `ollama-${stamp}@orkbot.test`, "password12", "Model setup");
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await page.getByRole("combobox", { name: "Provider" }).click();
  await page.getByRole("option", { name: "Ollama Cloud", exact: true }).click();
  await page.getByLabel("Model id", { exact: true }).fill("test-model");
  const continueButton = page.getByRole("button", { name: "Continue", exact: true });
  await expect(continueButton).toBeDisabled();
  const apiKey = page.getByLabel("API key", { exact: true });
  await apiKey.fill("   ");
  await expect(continueButton).toBeDisabled();
  await apiKey.fill("fake-test-key");
  await expect(continueButton).toBeEnabled();
  await apiKey.fill("");
  await expect(continueButton).toBeDisabled();
});

test("Ork credits are chosen like a provider, with nothing else to fill in", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: true, billingEnabled: true } },
    });
  });
  let funding: unknown = null;
  await page.route("**/rpc/billing/selectFunding", async (route) => {
    funding = route.request().postDataJSON().json;
    await route.fulfill({ json: { json: { ok: true } } });
  });
  await signup(page, `credits-${Date.now()}@orkbot.test`, "password12", "Credits");
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("combobox", { name: "Provider" }).click();
  await page.getByRole("option", { name: "Ork credits", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveCount(0);
  await expect(page.getByLabel(/API key/)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "onboarding-orkbot-credits");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(() => funding).toEqual({ funding: "credits" });
});

test("managed onboarding connects server accounts and requires a workspace default", async ({
  page,
}, testInfo) => {
  const account = {
    id: "server-account",
    label: "Server account",
    provider: "fixture-provider",
    models: ["workspace-model"],
    state: "active" as const,
    revision: 1,
    concurrencyLimit: 8,
    monthlyBudgetMicros: null,
  };
  const status: RpcOutput<"serverAI/status"> = {
    available: true,
    spaceId: "workspace-fixture",
    workspaceMonthlyBudgetMicros: null,
    canManageServer: true,
    canManageWorkspace: true,
    accounts: [],
    connections: [],
  };
  let ready = false;
  const retired: string[] = [];
  await page.route("**/rpc/me", async (route) => {
    try {
      const response = await route.fetch();
      const body = (await response.json()) as { json: Record<string, unknown> };
      await route.fulfill({ response, json: { json: { ...body.json, needsModel: !ready } } });
    } catch {
      await route.abort().catch(() => {});
    }
  });
  await page.route("**/rpc/models/workspacePolicy", (route) =>
    route.fulfill({ json: { json: { managed: true, canManage: false, policy: null } } }),
  );
  for (const method of ["list", "connect", "beginOAuth"]) {
    await page.route(`**/rpc/models/${method}`, (route) => {
      retired.push(method);
      return route.abort();
    });
  }
  await page.route("**/rpc/serverAI/status", (route) => route.fulfill({ json: { json: status } }));
  await page.route("**/rpc/serverAI/catalog", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            provider: "fixture-provider",
            providerName: "Fixture provider",
            id: "workspace-model",
            label: "Workspace model",
            auth: "both",
            signIn: "device-code",
            oauthLabel: "Sign in with fixture subscription",
            authHint: "Fixture subscription or API key",
            recommended: true,
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/serverAI/create", (route) => {
    const request = route.request().postDataJSON().json;
    expect(request.models).toEqual(account.models);
    expect(request.connection.provider).toBe(account.provider);
    expect(request.connection.apiKey).toBe("fake-test-key");
    status.accounts = [account];
    return route.fulfill({ json: { json: account } });
  });
  await page.route("**/rpc/serverAI/offer", (route) => {
    expect(route.request().postDataJSON().json).toEqual({
      spaceId: status.spaceId,
      connectionId: account.id,
      available: true,
    });
    status.connections = [
      {
        ...account,
        enabled: false,
        allowedModels: account.models,
        defaultModelId: null,
        isDefault: false,
        fallback: false,
        priority: 0,
        assignmentRevision: 1,
      },
    ];
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await page.route("**/rpc/serverAI/configure", (route) => {
    const { connectionId, ...patch } = route.request().postDataJSON().json;
    expect(connectionId).toBe(account.id);
    Object.assign(status.connections[0]!, patch);
    ready = status.connections[0]!.enabled && status.connections[0]!.isDefault;
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await signup(
    page,
    `managed-onboarding-${Date.now()}@orkbot.test`,
    "password12",
    "Workspace administrator",
  );
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Enable a default model");
  await page.getByRole("button", { name: "Add AI account", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Fixture provider");
  await expect(page.getByLabel("Models (one per line)", { exact: true })).toHaveValue(
    account.models[0]!,
  );
  const authentication = page.getByRole("combobox", { name: "Authentication", exact: true });
  await expect(authentication).toHaveValue("sign-in");
  await expect(
    page.getByRole("button", { name: "Sign in with fixture subscription", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "managed-onboarding-subscription-choice");
  await authentication.selectOption("key");
  await expect(page.getByLabel("API key", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in with fixture subscription", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Name", { exact: true }).fill(account.label);
  await captureScreenshot(page, testInfo, "managed-onboarding-server-account");
  await page.getByLabel("API key", { exact: true }).fill("fake-test-key");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Make available", exact: true }).click();
  await page.getByRole("switch", { name: "Enabled", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Default", exact: true })).toBeEnabled();
  await page.getByRole("switch", { name: "Default", exact: true }).click();
  await expect.poll(() => ready).toBe(true);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/app(?:\/|$)/);
  expect(retired).toEqual([]);
});

test("managed onboarding asks the workspace administrator instead of collecting personal keys", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
  });
  await page.route("**/rpc/models/workspacePolicy", (route) =>
    route.fulfill({ json: { json: { managed: true, canManage: false, policy: null } } }),
  );
  await page.route("**/rpc/serverAI/status", (route) =>
    route.fulfill({
      json: {
        json: {
          available: true,
          spaceId: "workspace-fixture",
          workspaceMonthlyBudgetMicros: null,
          canManageServer: false,
          canManageWorkspace: false,
          accounts: [],
          connections: [],
        },
      },
    }),
  );
  await signup(
    page,
    `managed-participant-${Date.now()}@orkbot.test`,
    "password12",
    "Workspace participant",
  );
  await expect(
    page.getByText("Ask a workspace administrator to enable an AI account for this workspace."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Add AI account", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "managed-onboarding-workspace-access");
});
