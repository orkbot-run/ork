// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  policy: vi.fn(),
  bootstrap: vi.fn(),
  selectedBootstrap: vi.fn(),
}));
vi.mock("../lib/bootstrap", () => ({
  peekInitialBootstrap: api.bootstrap,
  peekSelectedSpaceBootstrap: api.selectedBootstrap,
}));
vi.mock("../lib/rpc", () => ({
  SPACE_SELECTED_EVENT: "space-selected",
  captureRpcContext: () => ({
    client: { me: api.me, models: { workspacePolicy: api.policy } },
    isCurrent: () => true,
  }),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts[0] }),
}));

import { deferModelSetup } from "../lib/model-setup-preference";
import { ModelSetupGate } from "./ModelSetupGate";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/app/bot"]}>
        <Routes>
          <Route element={<ModelSetupGate />}>
            <Route path="/app/bot" element={<div>App content</div>} />
          </Route>
          <Route path="/onboarding/model" element={<div>Model setup</div>} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

it.each([
  { managed: true, mode: "pending", needsModel: false, expected: "Model setup" },
  { managed: true, mode: "organization", needsModel: true, expected: "Model setup" },
  { managed: true, mode: "personal", needsModel: true, expected: "Model setup" },
  { managed: true, mode: "organization", needsModel: false, expected: "App content" },
  { managed: false, mode: "legacy", needsModel: true, expected: "App content" },
])("gates app entry for $mode with needsModel=$needsModel", async (scenario) => {
  api.me.mockResolvedValue({ needsModel: scenario.needsModel });
  api.policy.mockResolvedValue({ managed: scenario.managed, modelSetupMode: scenario.mode });
  await render();
  expect(host.textContent).toContain(scenario.expected);
});

it("keeps the app closed after a failed check and retries", async () => {
  api.me.mockResolvedValue({ needsModel: false });
  api.policy.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ managed: true });
  await render();
  expect(host.textContent).toContain("Could not load model settings");
  expect(host.textContent).not.toContain("App content");
  await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("App content");
});

it("uses the bootstrap decision without opening another RPC channel", async () => {
  let resolve!: (bootstrap: { me: { managedModelSetupRequired: boolean } }) => void;
  api.bootstrap.mockReturnValue(
    new Promise((complete) => {
      resolve = complete;
    }),
  );
  await render();
  expect(api.me).not.toHaveBeenCalled();
  expect(api.policy).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("App content");
  await act(async () => resolve({ me: { managedModelSetupRequired: false } }));
  expect(host.textContent).toContain("App content");
  expect(api.policy).not.toHaveBeenCalled();
});

it("falls back to a fresh identity when the initial bootstrap fails", async () => {
  api.bootstrap.mockReturnValue(Promise.reject(new Error("bootstrap unavailable")));
  api.me.mockResolvedValue({ needsModel: false });
  api.policy.mockResolvedValue({ managed: false });
  await render();
  expect(api.me).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("App content");
});

it("does not reuse the startup identity after selecting another workspace", async () => {
  api.bootstrap.mockResolvedValue({ me: { needsModel: false } });
  api.policy.mockResolvedValue({ managed: true, modelSetupMode: "organization" });
  await render();
  expect(api.me).not.toHaveBeenCalled();
  api.me.mockResolvedValue({ needsModel: true });
  await act(async () => window.dispatchEvent(new Event("space-selected")));
  expect(api.me).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Model setup");
});

it("checks again when the selected workspace changes", async () => {
  api.me.mockResolvedValue({ needsModel: false });
  api.policy.mockResolvedValueOnce({ managed: true, modelSetupMode: "organization" });
  await render();
  expect(host.textContent).toContain("App content");
  api.policy.mockResolvedValueOnce({ managed: true, modelSetupMode: "pending" });
  await act(async () => window.dispatchEvent(new Event("space-selected")));
  expect(host.textContent).toContain("Model setup");
});

it("keeps a visited workspace open while rechecking its setup from the shared bootstrap", async () => {
  api.me.mockResolvedValue({ managedModelSetupRequired: false });
  await render();
  let resolve!: (bootstrap: { me: { managedModelSetupRequired: boolean } }) => void;
  api.selectedBootstrap.mockReturnValue({
    seed: { me: { managedModelSetupRequired: false } },
    promise: new Promise((complete) => {
      resolve = complete;
    }),
  });
  await act(async () => window.dispatchEvent(new Event("space-selected")));
  expect(host.textContent).toContain("App content");
  expect(api.me).toHaveBeenCalledOnce();
  await act(async () => resolve({ me: { managedModelSetupRequired: true } }));
  expect(host.textContent).toContain("Model setup");
});

it("opens the deferred workspace and still requires setup for a different workspace", async () => {
  const identity = { userId: "workspace-owner", spaceId: "deferred-space" };
  deferModelSetup(identity);
  api.me.mockResolvedValue({ ...identity, needsModel: true });
  api.policy.mockResolvedValue({ managed: true, modelSetupMode: "pending" });
  await render();
  expect(host.textContent).toContain("App content");
  api.me.mockResolvedValue({ ...identity, spaceId: "other-space", needsModel: true });
  await act(async () => window.dispatchEvent(new Event("space-selected")));
  expect(host.textContent).toContain("Model setup");
});
