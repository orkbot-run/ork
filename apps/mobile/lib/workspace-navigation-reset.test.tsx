// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  captureWorkspaceNavigationReset,
  useWorkspaceNavigationReset,
} from "./workspace-navigation-reset";

const state = vi.hoisted(() => ({
  pathname: "/thread",
  params: { botId: "private-A" } as Record<string, string>,
  generation: 2,
  server: "https://server.example.test",
  workspace: "B",
  account: "owner",
  dismissTo: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("expo-router", () => ({
  usePathname: () => state.pathname,
  useGlobalSearchParams: () => state.params,
  useRouter: () => ({ dismissTo: state.dismissTo, replace: state.replace }),
}));
vi.mock("./api", () => ({ currentApiBase: () => state.server }));
vi.mock("./session", () => ({ currentSessionGeneration: () => state.generation }));
vi.mock("./installation-transport", () => ({
  installationRevocationScope: () => ({ account: state.account, target: state.workspace }),
}));
const complete = vi.fn();
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let pending: ReturnType<typeof captureWorkspaceNavigationReset> | null;
function Screen({ ready }: { ready: boolean }) {
  const hidden = useWorkspaceNavigationReset(pending, ready, complete);
  return createElement("main", { hidden }, state.pathname === "/" ? "Inbox B" : "Thread A Stop");
}
const render = (ready: boolean) => act(async () => root.render(createElement(Screen, { ready })));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.pathname = "/thread";
  state.params = { botId: "private-A" };
  state.generation = 2;
  state.server = "https://server.example.test";
  state.workspace = "B";
  state.account = "owner";
  state.dismissTo.mockClear();
  state.replace.mockClear();
  complete.mockReset();
  pending = captureWorkspaceNavigationReset(JSON.stringify([state.pathname, state.params]));
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("hides the old thread until the replacement navigator mounts and reaches the B inbox", async () => {
  await render(false);
  expect(host.querySelector("main")?.hidden).toBe(true);
  expect(state.replace).not.toHaveBeenCalled();
  await render(true);
  expect(state.dismissTo).toHaveBeenCalledWith("/");
  expect(state.replace).toHaveBeenCalledWith("/");
  expect(complete).not.toHaveBeenCalled();
  state.pathname = "/";
  state.params = {};
  await render(true);
  expect(complete).toHaveBeenCalledWith(pending);
});

it.each(["account", "workspace", "generation", "server", "deep-link"])(
  "never overrides a newer %s while the navigator was unmounted",
  async (change) => {
    await render(false);
    if (change === "account") state.account = "another-owner";
    if (change === "workspace") state.workspace = "C";
    if (change === "generation") state.generation += 1;
    if (change === "server") state.server = "https://another.example.test";
    if (change === "deep-link") state.params = { botId: "new-deep-link" };
    await render(true);
    expect(state.replace).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(pending);
    expect(host.querySelector("main")?.hidden).toBe(false);
  },
);

it("keeps startup deep links when no explicit workspace selection requested a reset", async () => {
  pending = null;
  await render(true);
  expect(state.replace).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  expect(host.querySelector("main")?.hidden).toBe(false);
});
