// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ProtocolUpdateRequired } from "../lib/auth-capabilities";
import { ProtocolRecovery } from "./ProtocolRecovery";

const state = vi.hoisted(() => ({
  discover: vi.fn(),
  serverUpdates: vi.fn(() => ({ state: {}, updates: {} })),
  signedIn: true,
  response: undefined as ((response: Response) => void) | undefined,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@orkbot/contracts", async (original) => ({
  ...(await original<object>()),
  CLIENT_PROTOCOL_VERSION: 2,
}));
vi.mock("../lib/auth", () => ({
  authClient: { useSession: () => ({ isPending: false, data: state.signedIn ? {} : null }) },
}));
vi.mock("../lib/auth-capabilities", () => ({
  fetchAuthCapabilities: state.discover,
  resetAuthCapabilities: () => {},
  ProtocolUpdateRequired: class extends Error {
    constructor(readonly capabilities: unknown) {
      super("update required");
    }
  },
}));
vi.mock("../lib/rpc", () => ({
  onRpcResponse: (listener: (response: Response) => void) => {
    state.response = listener;
    return () => {
      state.response = undefined;
    };
  },
}));
vi.mock("../lib/server-updates", () => ({ useServerUpdates: state.serverUpdates }));
vi.mock("./DesktopUpdates", () => ({ DesktopUpdateSection: () => <div>Desktop updater</div> }));
vi.mock("./ServerUpdates", () => ({ ServerUpdateSection: () => <div>Server updater</div> }));
vi.mock("./PageLoading", () => ({ PageLoading: () => <div>Loading</div> }));
let cleanup = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  cleanup = () => {
    act(() => root.unmount());
  };
  await act(async () =>
    root.render(
      <ProtocolRecovery>
        <div>Product workspace</div>
      </ProtocolRecovery>,
    ),
  );
  return host;
}

it("opens the product only after compatible discovery", async () => {
  state.discover.mockResolvedValue({});
  expect((await render()).textContent).toBe("Product workspace");
});

it("keeps product screens unmounted and exposes server recovery when the server is too old", async () => {
  state.discover.mockRejectedValue(
    new ProtocolUpdateRequired({ protocol: { min: 1, max: 1 } } as never),
  );
  const view = await render();
  expect(view.textContent).not.toContain("Product workspace");
  expect(view.textContent).toContain("Update this server to continue.");
  expect(view.textContent).toContain("Server updater");
});

it("offers the native application updater when the client is too old", async () => {
  state.discover.mockRejectedValue(
    new ProtocolUpdateRequired({ protocol: { min: 3, max: 3 } } as never),
  );
  const view = await render();
  expect(view.textContent).not.toContain("Product workspace");
  expect(view.textContent).toContain("Update Ork to connect to this server.");
  expect(view.textContent).toContain("Desktop updater");
  expect(state.serverUpdates).not.toHaveBeenCalled();
});

it("keeps recovery visible if a subsequent capability check fails", async () => {
  vi.useFakeTimers();
  state.discover
    .mockRejectedValueOnce(new ProtocolUpdateRequired({ protocol: { min: 1, max: 1 } } as never))
    .mockRejectedValue(new Error("offline"));
  const view = await render();
  expect(view.textContent).toContain("Server updater");
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(view.textContent).toContain("Server updater");
  expect(view.textContent).not.toContain("Product workspace");
});

it("blocks the product on a 426 even when the follow-up discovery fails", async () => {
  state.discover.mockResolvedValueOnce({}).mockRejectedValue(new Error("offline"));
  const view = await render();
  expect(view.textContent).toContain("Product workspace");
  await act(async () => state.response?.({ status: 426 } as Response));
  expect(view.textContent).not.toContain("Product workspace");
  expect(view.textContent).toContain("Update Ork to connect to this server.");
});

it("keeps the client update gate when 426 reports an obsolete build with a compatible protocol", async () => {
  state.discover.mockResolvedValue({});
  const view = await render();
  await act(async () => state.response?.({ status: 426 } as Response));
  expect(view.textContent).toContain("Desktop updater");
  expect(view.textContent).not.toContain("Product workspace");
});

it("returns to the product once a confirmed outdated server becomes compatible", async () => {
  vi.useFakeTimers();
  state.discover
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new ProtocolUpdateRequired({ protocol: { min: 1, max: 1 } } as never))
    .mockResolvedValue({});
  const view = await render();
  await act(async () => state.response?.({ status: 426 } as Response));
  expect(view.textContent).toContain("Server updater");
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(view.textContent).toContain("Product workspace");
});
