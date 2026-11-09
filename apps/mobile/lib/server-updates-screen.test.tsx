// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ServerUpdatesStatus } from "@orkbot/contracts";
import type { ServerUpdatesView } from "@orkbot/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import Updates from "../app/(settings)/updates";

const store = vi.hoisted(() => ({
  state: { status: null, busy: null, error: false, uncertain: false } as ServerUpdatesView,
  updates: { check: vi.fn(), apply: vi.fn(), policy: vi.fn(), channel: vi.fn() },
}));
vi.mock("./server-updates", () => ({ useServerUpdates: () => store }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    children,
    actions,
    onPressAction,
  }: {
    children: ReactNode;
    actions: { id: string; title: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) => (
    <div>
      {children}
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          onClick={() => onPressAction({ nativeEvent: { event: action.id } })}
        >
          {action.title}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({ mutedForeground: "muted" }) }));
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/server-update-progress", () => ({
  ServerUpdateProgress: ({ label }: { label: string }) => (
    <div role="progressbar" aria-label={label} />
  ),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({
    title,
    value,
    onPress,
    disabled,
  }: {
    title: string;
    value?: string;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {title}
      {value}
    </button>
  ),
  SettingsSwitch: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <input
      aria-label={label}
      type="checkbox"
      checked={value}
      onChange={(event) => onChange(event.target.checked)}
    />
  ),
}));
const status: ServerUpdatesStatus = {
  available: true,
  mode: "manual",
  channel: "stable",
  currentRevision: "a".repeat(40),
  candidate: { revision: "b".repeat(40), version: "0.2.0" },
  lastCheckedAt: null,
  policyRevision: 1,
  lastRequest: null,
  error: null,
};
let cleanup = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function render(value: Partial<ServerUpdatesStatus> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store.state = { status: { ...status, ...value }, busy: null, error: false, uncertain: false };
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<Updates />));
  cleanup = () => {
    act(() => root.unmount());
  };
  return host;
}
it("uses native settings actions and an off-by-default automatic switch", async () => {
  const host = await render();
  expect(host.querySelector("input")!.checked).toBe(false);
  await act(async () => host.querySelector("input")!.click());
  expect(store.updates.policy).toHaveBeenCalledWith(true);
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((item) => item.textContent === "Check for updates")!
      .click(),
  );
  expect(store.updates.check).toHaveBeenCalledOnce();
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((item) => item.textContent === "Update server")!
      .click(),
  );
  expect(store.updates.apply).toHaveBeenCalledOnce();
});
it("hides unsupported and unauthorized controls", async () => {
  const host = await render({ available: false });
  expect(host.textContent).toBe("");
});
it("waits for status after a request is acknowledged", async () => {
  const host = await render({
    lastRequest: {
      id: "request",
      revision: status.candidate!.revision,
      state: "requested",
      requestedAt: new Date().toISOString(),
    },
  });
  expect(host.textContent).toContain("Waiting for update status…");
  expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(host.textContent).not.toContain("Up to date");
});
it("does not report an uncertain update as complete", async () => {
  const host = await render({
    lastRequest: {
      id: "request",
      revision: status.candidate!.revision,
      state: "unknown",
      requestedAt: new Date().toISOString(),
    },
  });
  expect(host.textContent).toContain("Could not confirm the update");
  expect(host.textContent).not.toContain("Server updated");
});
it("shows completion only when the server confirms it", async () => {
  const host = await render({
    lastRequest: {
      id: "request",
      revision: status.candidate!.revision,
      state: "completed",
      requestedAt: new Date().toISOString(),
    },
  });
  expect(host.textContent).toContain("Server updated");
});
it("offers stable and beta channels only when the server supports selecting them", async () => {
  const host = await render({ channelSelectable: true });
  expect(host.textContent).toContain("Stable");
  await act(async () =>
    [...host.querySelectorAll("button")].find((item) => item.textContent === "Beta")!.click(),
  );
  expect(store.updates.channel).toHaveBeenCalledWith("preview");
});

it("renders current phases, reconnects on network loss, and stops on terminal states", async () => {
  const request = {
    id: "request",
    revision: status.candidate!.revision,
    state: "requested" as const,
    requestedAt: new Date().toISOString(),
    phase: "downloading" as const,
  };
  const host = await render({ lastRequest: request });
  expect(host.textContent).toContain("Downloading update…");
  expect(host.querySelector('[role="progressbar"]')).not.toBeNull();

  cleanup();
  const restart = await render({ lastRequest: { ...request, phase: "restarting" } });
  expect(restart.textContent).toContain("Restarting server…");
  cleanup();

  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store.state = {
    status: { ...status, lastRequest: request },
    busy: null,
    error: true,
    uncertain: false,
  };
  const container = document.createElement("div");
  const networkRoot = createRoot(container);
  await act(async () => networkRoot.render(<Updates />));
  expect(container.textContent).toContain("Reconnecting…");
  expect(container.textContent).not.toContain("Could not complete");
  expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
  await act(async () => networkRoot.unmount());

  for (const state of ["completed", "failed", "unknown"] as const) {
    const terminal = await render({ lastRequest: { ...request, state } });
    expect(terminal.querySelector('[role="progressbar"]')).toBeNull();
    cleanup();
  }
  cleanup = () => {};
});
