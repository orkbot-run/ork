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
  updates: { check: vi.fn(), apply: vi.fn(), policy: vi.fn() },
}));
vi.mock("./server-updates", () => ({ useServerUpdates: () => store }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({ mutedForeground: "muted" }) }));
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({
    title,
    onPress,
    disabled,
  }: {
    title: string;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {title}
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
it("shows deployment acknowledgement as a request", async () => {
  const host = await render({
    lastRequest: {
      id: "request",
      revision: status.candidate!.revision,
      state: "requested",
      requestedAt: new Date().toISOString(),
    },
  });
  expect(host.textContent).toContain("Deployment requested");
  expect(host.textContent).not.toContain("Up to date");
});
