// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved. Native renderer entry selection is an Ork addition.

import type { RpcOutput } from "@orkbot/contracts";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";
import { expect, test } from "./renderer-test";

test.afterEach(async ({ page }) => {
  // Not "wait": a handler whose fulfill() lost a race to the route teardown never settles,
  // and "wait" would then hang the test to its timeout.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("managed organization settings are separate and explain model key ownership", async ({
  page,
}, testInfo) => {
  await signup(page, `settings-managed-${Date.now()}@orkbot.test`, "password12", "Administrator");
  await completeOnboarding(page);
  await page.route("**/rpc/models/workspacePolicy", (route) =>
    route.fulfill({
      json: {
        json: {
          managed: true,
          canManage: false,
          policy: null,
          personalModelsAllowed: true,
          modelSetupMode: "personal",
        },
      },
    }),
  );
  await page.route("**/rpc/serverAI/status", (route) =>
    route.fulfill({
      json: {
        json: {
          available: true,
          spaceId: "workspace-fixture",
          workspaceMonthlyBudgetMicros: null,
          canManageServer: true,
          canManageWorkspace: true,
          accounts: [],
          connections: [],
          modelSetupMode: "personal",
        },
      },
    }),
  );
  await page.route("**/rpc/serverAI/catalog", (route) => route.fulfill({ json: { json: [] } }));
  await page.reload();
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Organization settings" }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings.getByTestId("settings-nav-organization-models")).toBeVisible();
  await expect(settings.getByTestId("settings-nav-models")).toHaveCount(0);
  await settings.getByTestId("settings-nav-organization-models").click();
  await expect(settings.getByText(/Model keys are managed by this server/)).toBeVisible();
  await captureScreenshot(page, testInfo, "organization-settings-models");
  await settings.getByRole("button", { name: "Your settings" }).click();
  await expect(settings.getByTestId("settings-nav-models")).toHaveText("Personal models");
  await expect(settings.getByTestId("settings-nav-organization-models")).toHaveCount(0);
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
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
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
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByLabel("Model id", { exact: true }).fill("test-model");
  const continueButton = page.getByRole("button", { name: "Connect", exact: true });
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

test("a member waits for the administrator's model choice", async ({ page }) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
  });
  await page.route("**/rpc/models/workspacePolicy", (route) =>
    route.fulfill({
      json: {
        json: {
          managed: true,
          canManage: false,
          policy: null,
          personalModelsAllowed: false,
          modelSetupMode: "pending",
        },
      },
    }),
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
          modelSetupMode: "pending",
          adminAccessReason: "not_admin",
        },
      },
    }),
  );
  await signup(page, `model-wait-${Date.now()}@orkbot.test`, "password12", "Member");
  await expect(
    page.getByText("Waiting for an organization administrator to set up models."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Let people connect their own models" }),
  ).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Provider" })).toHaveCount(0);
});

test("an administrator starts directly with the current provider list", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
  });
  await page.route("**/rpc/models/workspacePolicy", (route) =>
    route.fulfill({
      json: {
        json: {
          managed: true,
          canManage: false,
          policy: null,
          personalModelsAllowed: false,
          modelSetupMode: "pending",
        },
      },
    }),
  );
  await page.route("**/rpc/serverAI/status", (route) =>
    route.fulfill({
      json: {
        json: {
          available: true,
          spaceId: "workspace-fixture",
          workspaceMonthlyBudgetMicros: null,
          canManageServer: true,
          canManageWorkspace: true,
          accounts: [],
          connections: [],
          modelSetupMode: "pending",
        },
      },
    }),
  );
  await page.route("**/rpc/serverAI/catalog", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            provider: "fixture-provider",
            providerName: "Fixture provider",
            id: "fixture-model",
            label: "Fixture model",
            auth: "api-key",
          },
        ],
      },
    }),
  );
  await signup(page, `model-mode-${Date.now()}@orkbot.test`, "password12", "Administrator");
  await expect(page.getByRole("combobox", { name: "Provider", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect organization models" })).toHaveCount(0);
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "organization-model-provider-choice");
});

test("a member can connect a personal model when the organization has none", async ({ page }) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
  });
  await page.route("**/rpc/models/workspacePolicy", (route) =>
    route.fulfill({
      json: {
        json: { managed: true, canManage: false, policy: null, personalModelsAllowed: true },
      },
    }),
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
  await signup(page, `personal-model-${Date.now()}@orkbot.test`, "password12", "Member");
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Provider" })).toBeVisible();
  await expect(page.getByText(/outside company servers/)).toBeVisible();
  await expect(page.getByTestId("server-ai-ready")).toHaveCount(0);
});

test("managed onboarding connects a key and enters chat with the server default", async ({
  page,
}, testInfo) => {
  const account = {
    id: "server-account",
    label: "Server account",
    provider: "fixture-provider",
    models: ["workspace-model", "workspace-model-two"],
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
          {
            provider: "fixture-provider",
            providerName: "Fixture provider",
            id: "workspace-model-two",
            label: "Second workspace model",
            auth: "both",
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/serverAI/create", (route) => {
    const request = route.request().postDataJSON().json;
    expect(request.models).toEqual([account.models[0]]);
    expect(request.connection.provider).toBe(account.provider);
    expect(request.connection.apiKey).toBe("fake-test-key");
    status.accounts = [account];
    status.modelSetupMode = "organization";
    status.connections = [
      {
        ...account,
        enabled: true,
        allowedModels: [account.models[0]!],
        defaultModelId: account.models[0]!,
        isDefault: true,
        fallback: false,
        priority: 0,
        assignmentRevision: 1,
      },
    ];
    ready = true;
    return route.fulfill({ json: { json: account } });
  });
  await signup(
    page,
    `managed-onboarding-${Date.now()}@orkbot.test`,
    "password12",
    "Workspace administrator",
  );
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Provider", exact: true })
    .selectOption("fixture-provider:key");
  await expect(page.getByLabel("API key", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Models (one per line)", { exact: true })).toBeHidden();
  await page.getByLabel("API key", { exact: true }).fill("fake-test-key");
  await captureScreenshot(page, testInfo, "managed-onboarding-server-key");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(() => ready).toBe(true);
  await expect(page).toHaveURL(/\/app(?:\/|$)/);
  expect(retired).toEqual([]);
});

test("a workspace administrator can defer model setup and reopen the workspace", async ({
  page,
}, testInfo) => {
  for (const method of ["me", "bootstrap"]) {
    await page.route(`**/rpc/${method}`, async (route) => {
      try {
        const response = await route.fetch();
        const body = (await response.json()) as {
          json: Record<string, unknown> & { me?: Record<string, unknown> };
        };
        const json =
          method === "me"
            ? { ...body.json, needsModel: true }
            : { ...body.json, me: { ...body.json.me, needsModel: true } };
        await route.fulfill({ response, json: { json } });
      } catch {
        await route.abort().catch(() => {});
      }
    });
  }
  await page.route("**/rpc/models/workspacePolicy", (route) =>
    route.fulfill({
      json: { json: { managed: true, canManage: false, policy: null, modelSetupMode: "pending" } },
    }),
  );
  const status: RpcOutput<"serverAI/status"> = {
    available: true,
    spaceId: "workspace-fixture",
    workspaceMonthlyBudgetMicros: null,
    canManageServer: true,
    canManageWorkspace: true,
    accounts: [],
    connections: [],
    modelSetupMode: "pending",
  };
  await page.route("**/rpc/serverAI/status", (route) => route.fulfill({ json: { json: status } }));
  await page.route("**/rpc/serverAI/catalog", (route) => route.fulfill({ json: { json: [] } }));
  await signup(
    page,
    `deferred-model-${Date.now()}@orkbot.test`,
    "password12",
    "Workspace administrator",
  );
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await captureScreenshot(page, testInfo, "managed-onboarding-skip-model");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("button", { name: "Connect a model", exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/app$/);
  await page.getByRole("button", { name: "Connect a model", exact: true }).click();
  await expect(page.getByTestId("server-ai-ready")).toBeVisible();
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
    page.getByText("Waiting for an organization administrator to set up models."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Add model connection", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "managed-onboarding-workspace-access");
});
