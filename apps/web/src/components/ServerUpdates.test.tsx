// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ServerUpdatesStatus } from "@orkbot/contracts";
import { createServerUpdates } from "@orkbot/core";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ServerUpdateSection } from "./ServerUpdates";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@orkbot/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
      {...props}
    />
  ),
}));
const status: ServerUpdatesStatus = {
  available: true,
  mode: "manual",
  channel: "preview",
  currentRevision: "a".repeat(40),
  candidate: { revision: "b".repeat(40), version: "0.2.0" },
  lastCheckedAt: null,
  policyRevision: 0,
  lastRequest: null,
  error: null,
};
let clean = () => {};
afterEach(() => {
  clean();
  vi.unstubAllGlobals();
});
async function render(overrides: Partial<ServerUpdatesStatus> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const api = {
    context: () => "server:session",
    status: vi.fn().mockResolvedValue({ ...status, ...overrides }),
    check: vi.fn().mockResolvedValue(status),
    apply: vi.fn().mockResolvedValue(status),
    policy: vi.fn().mockResolvedValue(status),
  };
  const updates = createServerUpdates(api);
  const stop = updates.watch(false);
  await Promise.resolve();
  await Promise.resolve();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const show = async () => {
    await act(async () =>
      root.render(<ServerUpdateSection updates={updates} state={updates.getSnapshot()} />),
    );
  };
  await show();
  clean = () => {
    act(() => root.unmount());
    stop();
    host.remove();
  };
  return { host, api, updates, show };
}
it("shows supported server controls and sends manual check, apply and opt-in policy", async () => {
  const view = await render();
  expect(view.host.textContent).toContain("Preview");
  const buttons = view.host.querySelectorAll("button");
  await act(async () => buttons[0]!.click());
  expect(view.api.check).toHaveBeenCalledOnce();
  await act(async () => view.host.querySelector("input")!.click());
  expect(view.api.policy).toHaveBeenCalledWith(
    { automatic: true, expectedRevision: 0 },
    expect.any(AbortSignal),
  );
  await act(async () => buttons[1]!.click());
  expect(view.api.apply).toHaveBeenCalledWith(
    { candidateRevision: status.candidate!.revision, idempotencyKey: expect.any(String) },
    expect.any(AbortSignal),
  );
});
it("keeps unsupported deployments hidden", async () => {
  const view = await render({ available: false });
  expect(view.host.textContent).toBe("");
  expect(view.api.check).not.toHaveBeenCalled();
});
it.each(["requested", "unknown"] as const)(
  "describes %s without claiming an installed update",
  async (state) => {
    const view = await render({
      lastRequest: {
        id: "request",
        revision: status.candidate!.revision,
        state,
        requestedAt: new Date().toISOString(),
      },
    });
    expect(view.host.textContent).toContain(
      state === "requested" ? "Deployment requested" : "Check deployment in server panel",
    );
    expect(view.host.textContent).not.toContain("Up to date");
    expect((view.host.querySelectorAll("button")[1] as HTMLButtonElement).disabled).toBe(true);
  },
);
