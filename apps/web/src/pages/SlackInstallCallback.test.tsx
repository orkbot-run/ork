// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited callback tests are preserved. Full document navigation is an Ork addition.

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

const complete = vi.hoisted(() => vi.fn());
const replace = vi.fn();

vi.mock("../lib/rpc", () => ({ rpc: { messaging: { installations: { complete } } } }));
vi.mock("../components/PageLoading", () => ({ PageLoading: () => <div>Loading</div> }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@orkbot/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
}));

import { SlackInstallCallbackPage } from "./SlackInstallCallback";

afterEach(() => {
  document.body.innerHTML = "";
  complete.mockReset();
  replace.mockReset();
  vi.unstubAllGlobals();
});

async function render(url: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("location", { replace });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/messaging/slack/callback" element={<SlackInstallCallbackPage />} />
          <Route path="/app" element={<div>App</div>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return container;
}

it("finishes the install as the signed-in user and opens messaging settings", async () => {
  complete.mockResolvedValue({ ok: true });
  await render("/messaging/slack/callback?state=fake-state&code=fake-code");
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledWith({ state: "fake-state", code: "fake-code" });
  expect(replace).toHaveBeenCalledWith("/app?settings=messaging");
});

it("shows a failure when the install cannot be finished", async () => {
  complete.mockRejectedValue(new Error("rejected"));
  const container = await render("/messaging/slack/callback?state=fake-state&code=fake-code");
  expect(container.textContent).toContain("Could not connect");
  await act(async () => container.querySelector("button")!.click());
  expect(replace).toHaveBeenCalledWith("/app?settings=messaging");
});

it("does not call the API when Slack returns without a code", async () => {
  const container = await render("/messaging/slack/callback?error=access_denied&state=fake-state");
  expect(complete).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Could not connect");
});
