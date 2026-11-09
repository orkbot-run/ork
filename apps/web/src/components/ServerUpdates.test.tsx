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

const serverVersion = vi.hoisted(() => vi.fn());
vi.mock("../lib/rpc", () => ({ rpc: { serverUpdates: { version: serverVersion } } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@orkbot/ui-web", () => ({
  Progress: ({ value, ...props }: { value: number | null }) => (
    <div role="progressbar" {...(value === null ? {} : { "aria-valuenow": value })} {...props} />
  ),
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  OptionSelect: ({
    value,
    options,
    onValueChange,
    ...props
  }: {
    value: string;
    options: { value: string; label: string }[];
    onValueChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)} {...props}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
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
  vi.useRealTimers();
});
async function render(overrides: Partial<ServerUpdatesStatus> = {}, version: string | null = null) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  serverVersion.mockResolvedValue({ revision: overrides.currentRevision ?? null, version });
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
it("shows the server revision without update controls when updates are unavailable", async () => {
  const view = await render({
    available: false,
    currentRevision: "a".repeat(40),
    candidate: null,
    channel: null,
  });
  expect(view.host.textContent).toContain("a".repeat(12));
  expect(view.host.querySelector("button")).toBeNull();
  expect(view.host.querySelector("input")).toBeNull();
  expect(view.api.check).not.toHaveBeenCalled();
});
it("shows the release version with its revision when both are known", async () => {
  const view = await render({ available: false, currentRevision: "a".repeat(40) }, "v1.2.3");
  expect(view.host.textContent).toContain(`v1.2.3 (${"a".repeat(12)})`);
  expect(view.host.textContent).not.toContain("vv1.2.3");
});
it("refreshes the release version after deployment and refuses a stale revision", async () => {
  vi.useFakeTimers();
  const oldRevision = "a".repeat(40);
  const newRevision = "b".repeat(40);
  const view = await render({ currentRevision: oldRevision }, "1.2.3");
  expect(view.host.textContent).toContain(`v1.2.3 (${"a".repeat(12)})`);
  serverVersion.mockResolvedValueOnce({ revision: oldRevision, version: "1.2.3" });
  serverVersion.mockResolvedValueOnce({ revision: newRevision, version: "1.2.4" });
  view.api.check.mockResolvedValueOnce({
    ...status,
    currentRevision: newRevision,
    candidate: null,
  });
  await act(async () => view.updates.check());
  await view.show();
  expect(view.host.textContent).toContain("b".repeat(12));
  expect(view.host.textContent).not.toContain("v1.2.3");
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(view.host.textContent).toContain(`v1.2.4 (${"b".repeat(12)})`);
});
it("ignores a delayed version response after another deployment", async () => {
  const view = await render({ currentRevision: "a".repeat(40) }, "1.2.3");
  let resolvePrevious!: (value: { revision: string; version: string }) => void;
  serverVersion.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePrevious = resolve;
      }),
  );
  view.api.check.mockResolvedValueOnce({
    ...status,
    currentRevision: "b".repeat(40),
    candidate: null,
  });
  await act(async () => view.updates.check());
  await view.show();
  serverVersion.mockResolvedValueOnce({ revision: "c".repeat(40), version: "1.2.5" });
  view.api.check.mockResolvedValueOnce({
    ...status,
    currentRevision: "c".repeat(40),
    candidate: null,
  });
  await act(async () => view.updates.check());
  await view.show();
  expect(view.host.textContent).toContain("v1.2.5");
  await act(async () => resolvePrevious({ revision: "b".repeat(40), version: "1.2.4" }));
  expect(view.host.textContent).toContain(`v1.2.5 (${"c".repeat(12)})`);
  expect(view.host.textContent).not.toContain("v1.2.4");
});
it("hides unsupported deployments without a known revision", async () => {
  const view = await render({ available: false, currentRevision: null });
  expect(view.host.textContent).toBe("");
  expect(view.api.check).not.toHaveBeenCalled();
});
it("lets the owner select the beta server channel", async () => {
  const view = await render({ channelSelectable: true, channel: "stable" });
  const select = view.host.querySelector<HTMLSelectElement>('[aria-label="Update channel"]');
  expect(select).not.toBeNull();
  await act(async () => {
    select!.value = "preview";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(view.api.policy).toHaveBeenCalledWith(
    { automatic: false, expectedRevision: 0, channel: "preview" },
    expect.any(AbortSignal),
  );
});
it("shows a completed server update", async () => {
  const view = await render({
    lastRequest: {
      id: "request",
      revision: status.candidate!.revision,
      state: "completed",
      requestedAt: new Date().toISOString(),
    },
  });
  expect(view.host.textContent).toContain("Server updated");
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
      state === "requested" ? "Waiting for update status…" : "Could not confirm the update",
    );
    expect(view.host.textContent).not.toContain("Up to date");
    expect((view.host.querySelectorAll("button")[1] as HTMLButtonElement).disabled).toBe(true);
  },
);

it.each([
  ["preparing", "Preparing update…"],
  ["downloading", "Downloading update…"],
  ["restarting", "Restarting server…"],
  ["verifying", "Verifying update…"],
  ["recovering", "Restoring previous version…"],
  ["updating", "Updating server…"],
] as const)("shows %s without inventing a percentage", async (phase, label) => {
  const view = await render({
    lastRequest: {
      id: "request",
      revision: status.candidate!.revision,
      state: "requested",
      phase,
      requestedAt: new Date().toISOString(),
    },
  });
  const bar = view.host.querySelector('[role="progressbar"]');
  expect(bar?.getAttribute("aria-label")).toBe(label);
  expect(bar?.hasAttribute("aria-valuenow")).toBe(false);
  expect(view.host.querySelector('[role="status"]')?.textContent).toBe(label);
  expect(view.host.textContent).not.toContain("%");
});

it.each(["completed", "failed", "unknown"] as const)("stops progress after %s", async (state) => {
  const view = await render({
    lastRequest: {
      id: "request",
      revision: status.candidate!.revision,
      state,
      phase: "restarting",
      requestedAt: new Date().toISOString(),
    },
  });
  expect(view.host.querySelector('[role="progressbar"]')).toBeNull();
});
