// @vitest-environment jsdom
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { RpcOutput } from "@orkbot/contracts";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({ generation: 1 }));
const api = vi.hoisted(() => ({
  me: vi.fn(),
  models: { workspacePolicy: vi.fn(), list: vi.fn(), connect: vi.fn(), beginOAuth: vi.fn() },
  serverAI: {
    status: vi.fn(),
    catalog: vi.fn(),
    create: vi.fn(),
    beginOAuth: vi.fn(),
    completeOAuth: vi.fn(),
    finishOAuth: vi.fn(),
    submitOAuthCode: vi.fn(),
    cancelOAuth: vi.fn(),
    update: vi.fn(),
    configure: vi.fn(),
    offer: vi.fn(),
    workspaceBudget: vi.fn(),
    chooseMode: vi.fn(),
  },
  onboarding: { ensureFirstBot: vi.fn(), start: vi.fn(), promptFocus: vi.fn() },
}));
vi.mock("../lib/rpc", () => ({
  rpc: api,
  selectedSpaceId: () => "workspace-a",
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  captureRpcContext: () => {
    const generation = context.generation;
    return { client: api, isCurrent: () => generation === context.generation };
  },
}));
vi.mock("../components/AccountMenu", () => ({ AccountMenu: () => null }));
vi.mock("../lib/sign-out", () => ({ useSignOut: () => ({ signingOut: false, logOut: vi.fn() }) }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
  Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
    value === 1 ? one : other,
}));

import { modelSetupDeferred } from "../lib/model-setup-preference";
import { OnboardingPage } from "./Onboarding";

const connection = {
  id: "account-a",
  label: "Server account A",
  provider: "fixture-provider",
  models: ["model-a"],
  state: "active" as const,
  revision: 1,
  concurrencyLimit: 8,
  monthlyBudgetMicros: null,
};
const assignment = {
  ...connection,
  enabled: false,
  allowedModels: ["model-a"],
  defaultModelId: "model-a",
  isDefault: true,
  fallback: false,
  priority: 0,
  assignmentRevision: 1,
};
const status = (patch: Partial<RpcOutput<"serverAI/status">> = {}) => ({
  available: true,
  spaceId: "workspace-a",
  workspaceMonthlyBudgetMicros: null,
  canManageServer: false,
  canManageWorkspace: false,
  accounts: [],
  connections: [],
  ...patch,
});
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  context.generation = 1;
  api.me.mockResolvedValue({ needsModel: true, needsSignupSurvey: false, billingEnabled: false });
  api.models.workspacePolicy.mockResolvedValue({ managed: true, canManage: false, policy: null });
  api.models.list.mockResolvedValue([]);
  api.serverAI.status.mockResolvedValue(status());
  api.serverAI.catalog.mockResolvedValue([
    {
      provider: "fixture-provider",
      providerName: "Fixture provider",
      id: "model-a",
      label: "Model A",
      auth: "api-key",
    },
  ]);
  api.serverAI.create.mockResolvedValue(connection);
  api.serverAI.cancelOAuth.mockResolvedValue({ ok: true });
  api.serverAI.update.mockResolvedValue({ ok: true });
  api.serverAI.configure.mockResolvedValue({ ok: true });
  api.serverAI.offer.mockResolvedValue({ ok: true });
  api.onboarding.ensureFirstBot.mockResolvedValue(null);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  focusManager.setFocused(undefined);
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/onboarding/model"]}>
          <Routes>
            <Route path="/onboarding/:step?" element={<OnboardingPage />} />
            <Route path="/app" element={<div data-testid="ready-app" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
async function field(label: string, value: string) {
  const id = [...host.querySelectorAll("label")].find(
    (node) => node.textContent === label,
  )?.htmlFor;
  const input = document.getElementById(id!) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLSelectElement;
  expect(input, label).not.toBeNull();
  await act(async () => {
    const proto =
      input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}
function noLegacyCredentials() {
  expect(api.models.list).not.toHaveBeenCalled();
  expect(api.models.connect).not.toHaveBeenCalled();
  expect(api.models.beginOAuth).not.toHaveBeenCalled();
}

it("waits for the organization administrator to make the initial model choice", async () => {
  api.models.workspacePolicy.mockResolvedValue({
    managed: true,
    canManage: false,
    policy: null,
    personalModelsAllowed: false,
    modelSetupMode: "pending",
  });
  api.serverAI.status.mockResolvedValue(status({ modelSetupMode: "pending" }));
  await render();
  await vi.waitFor(() =>
    expect(host.textContent).toContain("Waiting for an organization administrator"),
  );
  expect(host.textContent).not.toContain("Connect organization models");
  expect(api.models.list).not.toHaveBeenCalled();
});

it("explains when the server cannot verify an administrator's organization role", async () => {
  api.models.workspacePolicy.mockResolvedValue({
    managed: true,
    canManage: false,
    policy: null,
    personalModelsAllowed: false,
    modelSetupMode: "pending",
  });
  api.serverAI.status.mockResolvedValue(
    status({ modelSetupMode: "pending", adminAccessReason: "role_unavailable" }),
  );
  await render();
  await vi.waitFor(() =>
    expect(host.textContent).toContain("Your organization role could not be verified"),
  );
  expect(host.textContent).not.toContain("Connect organization models");
});

it("opens personal model setup when an administrator makes that choice", async () => {
  api.models.workspacePolicy.mockResolvedValue({
    managed: true,
    canManage: false,
    policy: null,
    personalModelsAllowed: false,
    modelSetupMode: "pending",
  });
  api.serverAI.status.mockResolvedValue(status({ modelSetupMode: "pending" }));
  await render();
  await vi.waitFor(() =>
    expect(host.textContent).toContain("Waiting for an organization administrator"),
  );
  await act(async () => focusManager.setFocused(false));
  api.models.workspacePolicy.mockResolvedValue({
    managed: true,
    canManage: false,
    policy: null,
    personalModelsAllowed: true,
    modelSetupMode: "personal",
  });
  api.serverAI.status.mockResolvedValue(status({ modelSetupMode: "personal" }));
  await act(async () => focusManager.setFocused(true));
  await vi.waitFor(() => expect(api.models.list).toHaveBeenCalledOnce());
  expect(host.textContent).toContain("outside company servers");
});

it("never exposes a credential form while workspace management policy is unresolved", async () => {
  let resolve!: (value: unknown) => void;
  api.models.workspacePolicy.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await render();
  expect(host.querySelector('[data-orkbot-surface="onboarding"]')).toBeNull();
  noLegacyCredentials();
  context.generation += 1;
  await act(async () => resolve({ managed: false, canManage: true, policy: null }));
  noLegacyCredentials();
  expect(host.querySelector('input[type="password"]')).toBeNull();
});

it("tells a workspace administrator how to obtain an account without exposing server configuration", async () => {
  api.serverAI.status.mockResolvedValue(status({ canManageWorkspace: true }));
  await render();
  expect(host.textContent).toContain("Waiting for an organization administrator");
  expect(host.textContent).not.toContain("Add model connection");
  expect(api.serverAI.catalog).not.toHaveBeenCalled();
  noLegacyCredentials();
});

it("opens the provider choice directly for an administrator with no model", async () => {
  api.serverAI.status.mockResolvedValue(
    status({ canManageServer: true, canManageWorkspace: true, modelSetupMode: "pending" }),
  );
  await render();
  expect(host.querySelector("select")).not.toBeNull();
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(host.textContent).not.toContain("Connect organization models");
  expect(host.textContent).not.toContain("Continue");
  noLegacyCredentials();
});

it("connects a key with provider defaults and enters chat after fresh server readiness", async () => {
  let connected = false;
  api.serverAI.status.mockImplementation(async () =>
    status({
      canManageServer: true,
      canManageWorkspace: true,
      modelSetupMode: connected ? "organization" : "pending",
      accounts: connected ? [connection] : [],
      connections: connected ? [{ ...assignment, enabled: true }] : [],
    }),
  );
  api.serverAI.create.mockImplementation(async () => {
    connected = true;
    api.me.mockResolvedValue({ needsModel: false });
    return connection;
  });
  await render();
  await field("Provider", "fixture-provider:key");
  expect(host.querySelector("details")?.open).toBe(false);
  await field("API key", "fixture-private-key");
  await click("Connect");
  await vi.waitFor(() => expect(api.onboarding.ensureFirstBot).toHaveBeenCalledOnce());
  expect(api.serverAI.create).toHaveBeenCalledWith(
    expect.objectContaining({
      label: "Fixture provider",
      models: ["model-a"],
      monthlyBudgetMicros: null,
      connection: expect.objectContaining({ apiKey: "fixture-private-key" }),
    }),
    { signal: expect.any(AbortSignal) },
  );
  expect(api.serverAI.offer).not.toHaveBeenCalled();
  expect(api.serverAI.configure).not.toHaveBeenCalled();
  noLegacyCredentials();
});

it("starts subscription authorization when its provider is selected", async () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  api.serverAI.status.mockResolvedValue(
    status({ canManageServer: true, canManageWorkspace: true, modelSetupMode: "pending" }),
  );
  api.serverAI.catalog.mockResolvedValue([
    {
      provider: "fixture-provider",
      providerName: "Fixture subscription",
      id: "model-a",
      label: "Model A",
      auth: "oauth",
    },
  ]);
  api.serverAI.beginOAuth.mockResolvedValue({
    loginId: "attempt",
    provider: "fixture-provider",
    mode: "device-code",
    verificationUri: "https://fixture.example/activate",
    userCode: "FIXTURE",
    expiresInSeconds: 600,
  });
  api.serverAI.completeOAuth.mockImplementation(() => new Promise(() => undefined));
  await render();
  await field("Provider", "fixture-provider:sign-in");
  expect(api.serverAI.beginOAuth).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "fixture-provider", models: ["model-a"] }),
    { signal: expect.any(AbortSignal) },
  );
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(host.textContent).toContain("FIXTURE");
  expect(host.textContent).toContain("enter this code on the provider’s page");
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    "Waiting for you to confirm the code",
  );
  await click("Cancel");
  vi.restoreAllMocks();
});

it("continues after the device code is approved on a legacy server", async () => {
  const browser = vi.spyOn(window, "open").mockReturnValue(null);
  const before = {
    canManageServer: true,
    canManageWorkspace: true,
    modelSetupMode: "legacy" as const,
  };
  api.serverAI.status.mockResolvedValue(status(before));
  api.serverAI.catalog.mockResolvedValue([
    {
      provider: "fixture-provider",
      providerName: "Fixture subscription",
      id: "model-a",
      label: "Model A",
      auth: "oauth",
    },
  ]);
  api.serverAI.beginOAuth.mockResolvedValue({
    loginId: "legacy-attempt",
    provider: "fixture-provider",
    mode: "device-code",
    verificationUri: "https://fixture.example/activate",
    userCode: "FIXTURE",
    expiresInSeconds: 600,
  });
  api.serverAI.completeOAuth.mockResolvedValue({ status: "ready" });
  api.serverAI.finishOAuth.mockImplementation(async () => {
    api.serverAI.status.mockResolvedValue(
      status({ ...before, connections: [{ ...assignment, enabled: true }] }),
    );
    api.me.mockResolvedValue({ needsModel: false });
    return { id: connection.id };
  });
  try {
    await render();
    await field("Provider", "fixture-provider:sign-in");
    await vi.waitFor(() => expect(host.querySelector('[data-testid="ready-app"]')).not.toBeNull());
    expect(api.serverAI.finishOAuth).toHaveBeenCalledOnce();
  } finally {
    browser.mockRestore();
  }
});

it("uses the desktop browser and retries activation without repeating subscription sign-in", async () => {
  const browser = vi.spyOn(window, "open").mockReturnValue(null);
  const open = vi.fn(async () => undefined);
  vi.stubGlobal("orkbotDesktop", { oauth: { open } });
  const before = {
    canManageServer: true,
    canManageWorkspace: true,
    modelSetupMode: "organization" as const,
  };
  api.serverAI.status.mockResolvedValue(status(before));
  api.serverAI.catalog.mockResolvedValue([
    {
      provider: "fixture-provider",
      id: "model-a",
      label: "Model A",
      auth: "oauth",
    },
  ]);
  api.serverAI.beginOAuth.mockResolvedValue({
    loginId: "device-attempt",
    provider: "fixture-provider",
    mode: "device-code",
    verificationUri: "https://fixture.example/activate",
    userCode: "FIXTURE",
    expiresInSeconds: 600,
  });
  api.serverAI.completeOAuth.mockResolvedValue({ status: "ready" });
  api.serverAI.finishOAuth.mockImplementation(async () => {
    api.serverAI.status.mockResolvedValue(
      status({ ...before, connections: [{ ...assignment, isDefault: false }] }),
    );
    return { id: connection.id };
  });
  api.serverAI.configure
    .mockRejectedValueOnce(new Error("Temporary configure failure"))
    .mockImplementationOnce(async () => {
      api.serverAI.status.mockResolvedValue(
        status({ ...before, connections: [{ ...assignment, enabled: true }] }),
      );
      api.me.mockResolvedValue({ needsModel: false });
      return { ok: true };
    });
  await render();
  await field("Provider", "fixture-provider:sign-in");
  expect(open).toHaveBeenCalledWith("https://fixture.example/activate");
  expect(browser).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not activate"),
  );
  await click("Retry");
  await vi.waitFor(() => expect(host.querySelector('[data-testid="ready-app"]')).not.toBeNull());
  expect(api.serverAI.beginOAuth).toHaveBeenCalledOnce();
  expect(api.serverAI.finishOAuth).toHaveBeenCalledOnce();
  expect(api.serverAI.configure).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionId: connection.id,
      enabled: true,
      defaultModelId: "model-a",
      isDefault: true,
      scope: "space",
      expectedRevision: 1,
    }),
    { signal: expect.any(AbortSignal) },
  );
});

it("lets an administrator defer setup for this workspace and enter the app without creating a model", async () => {
  const identity = { userId: "skip-member", spaceId: "workspace-a" };
  api.me.mockResolvedValue({ ...identity, needsModel: true });
  api.serverAI.status.mockResolvedValue(
    status({ canManageServer: true, modelSetupMode: "pending" }),
  );
  await render();
  await click("Skip for now");
  expect(host.querySelector('[data-testid="ready-app"]')).not.toBeNull();
  expect(modelSetupDeferred(identity)).toBe(true);
  expect(modelSetupDeferred({ ...identity, spaceId: "workspace-b" })).toBe(false);
  expect(api.serverAI.chooseMode).not.toHaveBeenCalled();
  expect(api.serverAI.create).not.toHaveBeenCalled();
  expect(api.onboarding.ensureFirstBot).not.toHaveBeenCalled();
});

it("skips model setup on a direct onboarding link when the server is configured", async () => {
  api.me.mockResolvedValue({ needsModel: false, needsSignupSurvey: false });
  await render();
  await vi.waitFor(() => expect(api.onboarding.ensureFirstBot).toHaveBeenCalledOnce());
  expect(host.querySelector("select")).toBeNull();
});

it("retries failed server status without exposing credentials or a continue bypass", async () => {
  api.serverAI.status.mockRejectedValue(new Error("Unavailable"));
  await render();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.textContent).not.toContain("Continue");
  api.serverAI.status.mockResolvedValue(status());
  await click("Retry");
  await vi.waitFor(() =>
    expect(host.textContent).toContain("Waiting for an organization administrator"),
  );
  noLegacyCredentials();
});

it("ignores a ready status after the current account changes", async () => {
  await render();
  context.generation += 1;
  api.serverAI.status.mockResolvedValue(
    status({ modelSetupMode: "organization", connections: [{ ...assignment, enabled: true }] }),
  );
  await act(async () => queryClient.invalidateQueries());
  expect(api.onboarding.ensureFirstBot).not.toHaveBeenCalled();
});

it("preserves an unfinished key when permissions refresh on focus", async () => {
  api.serverAI.status.mockResolvedValue(
    status({ canManageServer: true, canManageWorkspace: true, modelSetupMode: "pending" }),
  );
  await render();
  await field("Provider", "fixture-provider:key");
  await field("API key", "unfinished-fixture-key");
  const calls = api.serverAI.status.mock.calls.length;
  await act(async () => focusManager.setFocused(false));
  await act(async () => focusManager.setFocused(true));
  await vi.waitFor(() => expect(api.serverAI.status.mock.calls.length).toBeGreaterThan(calls));
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(
    "unfinished-fixture-key",
  );
});
