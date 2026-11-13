// @vitest-environment jsdom
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { RpcOutput } from "@orkbot/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  api.serverAI.configure.mockResolvedValue({ ok: true });
  api.serverAI.offer.mockResolvedValue({ ok: true });
  api.onboarding.ensureFirstBot.mockResolvedValue(null);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
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

it("lets a delegated server administrator create and offer an account without silently assigning workspace access", async () => {
  let created = false;
  api.serverAI.status.mockImplementation(async () =>
    status({ canManageServer: true, accounts: created ? [connection] : [] }),
  );
  api.serverAI.create.mockImplementation(async () => {
    created = true;
    return connection;
  });
  await render();
  await click("Add AI account");
  await field("Name", "Fixture server account");
  await field("Models (one per line)", "model-a");
  await field("API key", "fake-non-secret-key");
  await click("Save");
  expect(api.serverAI.create).toHaveBeenCalledWith(
    expect.objectContaining({
      label: "Fixture server account",
      connection: expect.objectContaining({ apiKey: "fake-non-secret-key" }),
    }),
    { signal: expect.any(AbortSignal) },
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await click("Make available");
  expect(api.serverAI.offer).toHaveBeenCalledWith(
    { spaceId: "workspace-a", connectionId: "account-a", available: true },
    { signal: expect.any(AbortSignal) },
  );
  expect(api.serverAI.configure).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Ask a workspace administrator");
  noLegacyCredentials();
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
    }),
    { signal: expect.any(AbortSignal) },
  );
  expect(api.serverAI.create).not.toHaveBeenCalled();
  api.me.mockResolvedValue({ needsModel: false, needsSignupSurvey: false });
  await click("Continue");
  expect(host.querySelector('[data-testid="ready-app"]')).not.toBeNull();
  noLegacyCredentials();
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
