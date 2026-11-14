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

import { OnboardingPage } from "./Onboarding";
import { ServerAISettings } from "./ServerAISettings";

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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  const input = document.getElementById(id!) as HTMLInputElement | HTMLTextAreaElement;
  expect(input, label).not.toBeNull();
  await act(async () => {
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function noLegacyCredentials() {
  expect(api.models.list).not.toHaveBeenCalled();
  expect(api.models.connect).not.toHaveBeenCalled();
  expect(api.models.beginOAuth).not.toHaveBeenCalled();
}

it("keeps a managed participant out of provider secrets and explains the required workspace assignment", async () => {
  await render();
  expect(host.textContent).toContain("Ask a workspace administrator");
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(api.serverAI.catalog).not.toHaveBeenCalled();
  noLegacyCredentials();
  await click("Continue");
  expect(api.onboarding.ensureFirstBot).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});

it("creates an unlimited account and offers it to the workspace during onboarding", async () => {
  let created = false;
  let offered = false;
  let enabled = false;
  let revision = 1;
  api.serverAI.status.mockImplementation(async () =>
    status({
      canManageServer: true,
      canManageWorkspace: true,
      accounts: created ? [connection] : [],
      connections: offered
        ? [
            {
              ...assignment,
              enabled,
              isDefault: false,
              defaultModelId: enabled ? "model-a" : null,
              assignmentRevision: revision,
            },
          ]
        : [],
    }),
  );
  api.serverAI.create.mockImplementation(async () => {
    created = true;
    return connection;
  });
  api.serverAI.offer.mockImplementation(async () => {
    offered = true;
    return { ok: true };
  });
  api.serverAI.configure.mockImplementation(async (input) => {
    enabled = input.enabled;
    revision += 1;
    return { ok: true };
  });
  await render();
  expect(host.textContent).not.toContain("budget");
  await click("Add AI account");
  expect(host.textContent).not.toContain("budget");
  await field("Name", "Fixture server account");
  await field("Models (one per line)", "model-a");
  await field("API key", "fake-non-secret-key");
  await click("Save");
  expect(api.serverAI.create).toHaveBeenCalledWith(
    expect.objectContaining({
      label: "Fixture server account",
      monthlyBudgetMicros: null,
      connection: expect.objectContaining({ apiKey: "fake-non-secret-key" }),
    }),
    { signal: expect.any(AbortSignal) },
  );
  await vi.waitFor(() => expect(host.textContent).toContain("Make available"));
  await click("Make available");
  expect(api.serverAI.offer).toHaveBeenCalledExactlyOnceWith(
    { spaceId: "workspace-a", connectionId: "account-a", available: true },
    { signal: expect.any(AbortSignal) },
  );
  await vi.waitFor(() => expect(host.querySelector('[role="switch"]')).not.toBeNull());
  let switches = host.querySelectorAll<HTMLButtonElement>('[role="switch"]');
  await act(async () => switches[0]!.click());
  expect(api.serverAI.configure).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionId: "account-a",
      enabled: true,
      preserveBudget: true,
      preserveDefault: true,
      expectedRevision: assignment.assignmentRevision,
    }),
    { signal: expect.any(AbortSignal) },
  );
  await vi.waitFor(() => {
    switches = host.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    expect(switches[0]?.getAttribute("aria-checked")).toBe("true");
  });
  await act(async () => switches[1]!.click());
  expect(api.serverAI.configure).toHaveBeenLastCalledWith(
    expect.objectContaining({
      connectionId: "account-a",
      enabled: true,
      isDefault: true,
      preserveBudget: true,
      expectedRevision: 2,
    }),
    { signal: expect.any(AbortSignal) },
  );
  noLegacyCredentials();
});

it("hides account editing and preserves assignment limits during onboarding", async () => {
  const limited = { ...connection, monthlyBudgetMicros: 1_234_567 };
  const limitedAssignment = { ...assignment, monthlyBudgetMicros: 7_654_321 };
  api.serverAI.status.mockResolvedValue(
    status({
      canManageServer: true,
      canManageWorkspace: true,
      accounts: [limited],
      connections: [limitedAssignment],
      workspaceMonthlyBudgetMicros: 9_876_543,
    }),
  );
  await render();
  expect(host.textContent).not.toContain("budget");
  expect(host.textContent).not.toContain("Edit AI account");
  expect(api.serverAI.update).not.toHaveBeenCalled();
  await click("Models and limits");
  expect(host.textContent).not.toContain("budget");
  await click("Save");
  expect(api.serverAI.configure).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionId: limited.id,
      monthlyBudgetMicros: 7_654_321,
      preserveBudget: true,
      expectedRevision: limitedAssignment.assignmentRevision,
    }),
    { signal: expect.any(AbortSignal) },
  );
  expect(api.serverAI.workspaceBudget).not.toHaveBeenCalled();
});

it("adds an unlimited subscription and explicitly enables it as the default model", async () => {
  let signedIn = false;
  let offered = false;
  let enabled = false;
  let revision = 1;
  const subscription = { ...connection, id: "subscription-account" };
  api.serverAI.status.mockImplementation(async () =>
    status({
      canManageServer: true,
      canManageWorkspace: true,
      accounts: signedIn ? [subscription] : [],
      connections: offered
        ? [
            {
              ...assignment,
              ...subscription,
              enabled,
              isDefault: false,
              assignmentRevision: revision,
            },
          ]
        : [],
    }),
  );
  api.serverAI.catalog.mockResolvedValue([
    {
      provider: "fixture-provider",
      providerName: "Fixture provider",
      id: "model-a",
      label: "Model A",
      auth: "oauth",
    },
  ]);
  api.serverAI.beginOAuth.mockResolvedValue({
    loginId: "fixture-login",
    provider: "fixture-provider",
    mode: "auth-url",
    verificationUri: "https://example.test/authorize",
    expiresInSeconds: 600,
  });
  api.serverAI.submitOAuthCode.mockResolvedValue({ ok: true });
  api.serverAI.completeOAuth.mockResolvedValue({ status: "ready" });
  api.serverAI.finishOAuth.mockImplementation(async () => {
    signedIn = true;
    return { id: subscription.id };
  });
  api.serverAI.offer.mockImplementation(async () => {
    offered = true;
    return { ok: true };
  });
  api.serverAI.configure.mockImplementation(async (input) => {
    enabled = input.enabled;
    revision += 1;
    return { ok: true };
  });
  vi.stubGlobal("open", vi.fn());
  await render();
  await vi.waitFor(() => {
    expect(
      [...host.querySelectorAll("button")].find((node) => node.textContent === "Add AI account")
        ?.disabled,
    ).toBe(false);
  });
  await click("Add AI account");
  expect(host.textContent).not.toContain("budget");
  await click("Sign in");
  expect(api.serverAI.beginOAuth).toHaveBeenCalledWith(
    expect.objectContaining({ monthlyBudgetMicros: null, codePage: true }),
    { signal: expect.any(AbortSignal) },
  );
  await field("Verification code", "fixture-code");
  await click("Complete sign-in");
  await vi.waitFor(() => expect(host.textContent).toContain("Make available"));
  await click("Make available");
  expect(api.serverAI.offer).toHaveBeenCalledWith(
    { spaceId: "workspace-a", connectionId: subscription.id, available: true },
    { signal: expect.any(AbortSignal) },
  );
  await vi.waitFor(() => expect(host.querySelector('[role="switch"]')).not.toBeNull());
  let switches = host.querySelectorAll<HTMLButtonElement>('[role="switch"]');
  await act(async () => switches[0]!.click());
  expect(api.serverAI.configure).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionId: subscription.id,
      enabled: true,
      preserveBudget: true,
      preserveDefault: true,
      expectedRevision: 1,
    }),
    { signal: expect.any(AbortSignal) },
  );
  await vi.waitFor(() => {
    switches = host.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    expect(switches.length, host.textContent ?? "").toBeGreaterThan(1);
    expect(switches[0]?.getAttribute("aria-checked")).toBe("true");
  });
  await act(async () => switches[1]!.click());
  expect(api.serverAI.configure).toHaveBeenLastCalledWith(
    expect.objectContaining({
      connectionId: subscription.id,
      enabled: true,
      isDefault: true,
      preserveBudget: true,
      expectedRevision: 2,
    }),
    { signal: expect.any(AbortSignal) },
  );
});

it("keeps budget controls available in embedded settings", async () => {
  api.serverAI.status.mockResolvedValue(
    status({
      canManageWorkspace: true,
      canManageServer: true,
      accounts: [connection],
      connections: [assignment],
    }),
  );
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ServerAISettings embedded onClose={() => undefined} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).toContain("Workspace monthly budget (USD)");
  expect(host.textContent).toContain("Edit AI account");
  const enabled = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => enabled.click());
  expect(api.serverAI.configure).toHaveBeenCalledOnce();
  expect(api.serverAI.configure.mock.calls[0]![0]).not.toHaveProperty("preserveBudget");
  expect(api.serverAI.configure.mock.calls[0]![0]).not.toHaveProperty("expectedRevision");
  expect(api.serverAI.configure.mock.calls[0]![0]).not.toHaveProperty("preserveDefault");
});

it("lets a workspace administrator enable an offered model and continues only after fresh server readiness", async () => {
  api.serverAI.status.mockResolvedValue(
    status({ canManageWorkspace: true, connections: [assignment] }),
  );
  await render();
  expect(api.serverAI.catalog).not.toHaveBeenCalled();
  expect(host.querySelector('input[type="password"]')).toBeNull();
  const enabled = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => enabled.click());
  expect(api.serverAI.configure).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionId: "account-a",
      enabled: true,
      defaultModelId: "model-a",
      preserveBudget: true,
      expectedRevision: assignment.assignmentRevision,
      preserveDefault: true,
    }),
    { signal: expect.any(AbortSignal) },
  );
  expect(api.serverAI.create).not.toHaveBeenCalled();
  api.me.mockResolvedValue({ needsModel: false, needsSignupSurvey: false });
  await click("Continue");
  expect(host.querySelector('[data-testid="ready-app"]')).not.toBeNull();
  noLegacyCredentials();
});

it("keeps the default on fallback changes but allows an explicit default change", async () => {
  api.serverAI.status.mockResolvedValue(
    status({ canManageWorkspace: true, connections: [{ ...assignment, enabled: true }] }),
  );
  await render();
  let switches = host.querySelectorAll<HTMLButtonElement>('[role="switch"]');
  await act(async () => switches[2]!.click());
  expect(api.serverAI.configure.mock.calls[0]![0]).toEqual(
    expect.objectContaining({ preserveDefault: true, expectedRevision: 1, fallback: true }),
  );
  switches = host.querySelectorAll<HTMLButtonElement>('[role="switch"]');
  await act(async () => switches[1]!.click());
  expect(api.serverAI.configure.mock.calls[1]![0]).toEqual(
    expect.objectContaining({ expectedRevision: 1, isDefault: false }),
  );
  expect(api.serverAI.configure.mock.calls[1]![0]).not.toHaveProperty("preserveDefault");
});

it("reports an assignment conflict without overwriting a newer change", async () => {
  let revision = assignment.assignmentRevision;
  api.serverAI.status.mockImplementation(async () =>
    status({
      canManageWorkspace: true,
      connections: [{ ...assignment, assignmentRevision: revision }],
    }),
  );
  api.serverAI.configure.mockImplementationOnce(async () => {
    revision += 1;
    throw new Error("Assignment changed");
  });
  await render();
  const statusCalls = api.serverAI.status.mock.calls.length;
  const enabled = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => enabled.click());
  expect(api.serverAI.configure).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      connectionId: assignment.id,
      expectedRevision: assignment.assignmentRevision,
      preserveBudget: true,
    }),
    { signal: expect.any(AbortSignal) },
  );
  expect(api.serverAI.status.mock.calls.length).toBeGreaterThan(statusCalls);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
  expect(api.serverAI.configure).toHaveBeenCalledOnce();
  const currentEnabled = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => currentEnabled.click());
  expect(api.serverAI.configure).toHaveBeenCalledTimes(2);
  expect(api.serverAI.configure).toHaveBeenLastCalledWith(
    expect.objectContaining({
      connectionId: assignment.id,
      expectedRevision: revision,
      preserveBudget: true,
    }),
    { signal: expect.any(AbortSignal) },
  );
});

it("fails closed on policy discovery errors and retries without exposing the unmanaged form", async () => {
  api.models.workspacePolicy.mockRejectedValueOnce(new Error("Policy unavailable"));
  await render();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  noLegacyCredentials();
  await click("Retry");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).toContain("No AI accounts assigned");
  noLegacyCredentials();
});

it("does not continue onboarding from a readiness response owned by an old account", async () => {
  await render();
  let resolve!: (value: unknown) => void;
  api.me.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await click("Continue");
  context.generation += 1;
  expect(api.me).toHaveBeenCalledTimes(2);
  await act(async () => resolve({ needsModel: false, needsSignupSurvey: false }));
  expect(api.onboarding.ensureFirstBot).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="ready-app"]')).toBeNull();
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
  expect(host.textContent).toContain("Ask a server administrator");
  expect(host.textContent).not.toContain("Add AI account");
  expect(api.serverAI.catalog).not.toHaveBeenCalled();
  noLegacyCredentials();
});

it("refreshes model permissions after returning to the app", async () => {
  api.serverAI.status.mockResolvedValue(status({ canManageWorkspace: true }));
  await render();
  expect(host.textContent).not.toContain("Add AI account");
  await act(async () => focusManager.setFocused(false));
  api.serverAI.status.mockResolvedValue(
    status({ canManageWorkspace: true, canManageServer: true }),
  );
  await act(async () => focusManager.setFocused(true));
  await vi.waitFor(() => expect(host.textContent).toContain("Add AI account"));
});

it("preserves the account form while permissions refresh on focus", async () => {
  api.serverAI.status.mockResolvedValue(
    status({ canManageWorkspace: true, canManageServer: true }),
  );
  await render();
  await vi.waitFor(() => {
    expect(
      [...host.querySelectorAll("button")].find((node) => node.textContent === "Add AI account")
        ?.disabled,
    ).toBe(false);
  });
  await click("Add AI account");
  await field("Name", "Unfinished account");
  const callsBeforeFocus = api.serverAI.status.mock.calls.length;
  await act(async () => focusManager.setFocused(false));
  await act(async () => focusManager.setFocused(true));
  await vi.waitFor(() =>
    expect(api.serverAI.status.mock.calls.length).toBeGreaterThan(callsBeforeFocus),
  );
  const id = [...host.querySelectorAll("label")].find(
    (node) => node.textContent === "Name",
  )?.htmlFor;
  expect((document.getElementById(id!) as HTMLInputElement).value).toBe("Unfinished account");
});

it("keeps server status failures retryable and prevents a readiness bypass", async () => {
  api.serverAI.status.mockRejectedValue(new Error("Status unavailable"));
  await render();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(
    [...host.querySelectorAll("button")].find((node) => node.textContent === "Continue")?.disabled,
  ).toBe(true);
  expect(api.me).toHaveBeenCalledTimes(1);
  api.serverAI.status.mockResolvedValue(status());
  await click("Retry");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).toContain("No AI accounts assigned");
  noLegacyCredentials();
});

it("does not mistake an unavailable fresh readiness check for completed onboarding", async () => {
  await render();
  api.me.mockRejectedValueOnce(new Error("Readiness unavailable"));
  await click("Continue");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Readiness unavailable");
  expect(api.onboarding.ensureFirstBot).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="ready-app"]')).toBeNull();
});

it("keeps a temporarily unavailable managed AI service on a retryable managed screen", async () => {
  api.serverAI.status.mockResolvedValue(status({ available: false }));
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load model settings",
  );
  expect(
    [...host.querySelectorAll("button")].find((node) => node.textContent === "Continue")?.disabled,
  ).toBe(true);
  api.serverAI.status.mockResolvedValue(status());
  await click("Retry");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  noLegacyCredentials();
});
