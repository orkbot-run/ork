// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  resume: undefined as ((status: string) => void) | undefined,
  remove: vi.fn(),
  openUrl: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, callback: (status: string) => void) => {
      fake.resume = callback;
      return { remove: fake.remove };
    },
  },
  Linking: { openURL: fake.openUrl },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./api", () => ({
  captureApiRequestContext: async () => ({
    apiBase: "https://ork.example.test",
    sessionGeneration: 3,
    headers: { "x-orkbot-space-id": "space" },
  }),
  currentApiBase: () => "https://ork.example.test",
  selectedSpaceId: () => "space",
  subscribeConfirmedSpaceSwitch: () => () => undefined,
  rpc: fake.rpc,
}));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text }),
}));
vi.mock("./native", () => ({
  native: {},
  useMobileTokens: () => ({}),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 3 }));
vi.mock("../components/connector-icon", () => ({ ConnectorIcon: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    busy,
    label,
    onPress,
  }: {
    busy: boolean;
    label: string;
    onPress: () => void;
  }) => (
    <button type="button" disabled={busy} onClick={onPress}>
      {label}
    </button>
  ),
}));

import { AppConnectCard } from "../components/AppConnectCard";

it("keeps a slow connection pending and completes the same attempt on return to the app", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let status = "pending";
  fake.rpc.mockImplementation(async (procedure: string) => {
    if (procedure === "connections/begin")
      return { connectionId: "slow-attempt", authorizationUrl: "https://identity.example.test" };
    if (procedure === "connections/complete") return { status };
    if (procedure === "onboarding/appConnected") return { ok: true };
    throw new Error(`Unexpected RPC ${procedure}`);
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <AppConnectCard
          botId="bot"
          threadId="thread"
          messageId="card"
          block={{
            kind: "app_connect",
            status: "pending",
            provider: "calendar",
            connectorId: "integration",
            name: "Calendar",
            description: "",
            logo: null,
          }}
        />,
      ),
    );
    await act(async () => container.querySelector("button")?.click());
    expect(fake.openUrl).toHaveBeenCalledWith("https://identity.example.test");
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(container.querySelector("button")?.textContent).toBe("Start over");
    expect(container.querySelector("button")?.disabled).toBe(false);
    expect(container.textContent).toContain("Waiting for authorization.");
    const callsBeforeResume = fake.rpc.mock.calls.length;
    await act(async () => fake.resume?.("background"));
    expect(fake.rpc).toHaveBeenCalledTimes(callsBeforeResume);

    status = "connected";
    await act(async () => fake.resume?.("active"));
    expect(fake.rpc.mock.calls[callsBeforeResume]?.slice(0, 2)).toEqual([
      "connections/complete",
      { connectionId: "slow-attempt" },
    ]);
    expect(fake.rpc).toHaveBeenLastCalledWith(
      "onboarding/appConnected",
      expect.objectContaining({ messageId: "card" }),
      expect.objectContaining({
        requestContext: expect.objectContaining({ sessionGeneration: 3 }),
      }),
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("Connected");
    expect(fake.remove).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
