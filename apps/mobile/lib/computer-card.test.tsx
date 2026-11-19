// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ComputerFrame } from "@orkbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputerCard } from "../components/ComputerCard";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  foreground: true,
  readOnly: false,
  requestContext: {},
}));

vi.mock("./api", () => ({
  captureApiRequestContext: async () => state.requestContext,
  rpc: state.rpc,
}));
vi.mock("./app-foreground", () => ({ useAppForeground: () => state.foreground }));
vi.mock("./thread-read-only", () => ({ useThreadReadOnly: () => state.readOnly }));
vi.mock("./native", () => ({
  native: {},
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("@orkbot/chat-ui/native", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));
vi.mock("react-native", () => ({
  Image: ({
    source,
    accessibilityLabel,
    resizeMode,
  }: {
    source: { uri: string };
    accessibilityLabel: string;
    resizeMode: string;
  }) => <img src={source.uri} alt={accessibilityLabel} data-resize={resizeMode} />,
  Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: object) => styles },
  useWindowDimensions: () => ({ width: 393 }),
}));

const frame: ComputerFrame = {
  id: "d".repeat(64),
  capturedAt: "2026-11-18T20:00:00.000Z",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=",
  width: 1,
  height: 1,
};
const observe = "computer/takeoverPreview";
const onOpen = vi.fn();
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.foreground = true;
  state.readOnly = false;
  state.rpc.mockReset();
  onOpen.mockReset();
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const renderCard = async (runId?: string) =>
  act(async () => {
    root.render(
      <ComputerCard
        block={{ kind: "computer", state: "Needs you", text: "Confirm sign-in." }}
        botId="test-bot"
        runId={runId}
        messageId={`request-${runId}`}
        onOpen={onOpen}
      />,
    );
  });
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((element) => element.textContent === label);

it("uses one current preview and refreshes on foreground without reviving a superseded capture", async () => {
  let finishOld!: (frame: ComputerFrame) => void;
  state.rpc
    .mockImplementationOnce(
      () =>
        new Promise<ComputerFrame>((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValue(frame);
  await renderCard("old");
  const signal = state.rpc.mock.calls[0]?.[2].signal as AbortSignal;
  await renderCard("new");
  expect(signal.aborted).toBe(true);
  expect(host.querySelector("img")?.dataset.resize).toBe("contain");
  expect(state.rpc.mock.calls.map((call) => [call[0], call[1]])).toEqual([
    [observe, { botId: "test-bot", runId: "old", messageId: "request-old" }],
    [observe, { botId: "test-bot", runId: "new", messageId: "request-new" }],
  ]);
  await act(async () => finishOld({ ...frame, data: "expired" }));
  expect(host.querySelector("img")?.src).not.toContain("expired");
  state.foreground = false;
  await renderCard("new");
  expect(host.querySelector("img")).toBeNull();
  state.foreground = true;
  await renderCard("new");
  expect(state.rpc).toHaveBeenCalledTimes(3);
  state.readOnly = true;
  await renderCard("new");
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelectorAll("button")).toHaveLength(0);
});

it("sends Done for the exact request and collapses the original text", async () => {
  state.rpc.mockResolvedValueOnce(frame).mockResolvedValueOnce({ ok: true, resolved: true });
  await renderCard("running");
  await act(async () => button("Done")!.click());
  expect(state.rpc).toHaveBeenLastCalledWith(
    "computer/release",
    {
      botId: "test-bot",
      runId: "running",
      messageId: "request-running",
      reason: "done",
    },
    { requestContext: state.requestContext },
  );
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).not.toContain("Confirm sign-in.");
  await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("Confirm sign-in.");
});

it("keeps only Take control on an imported card", async () => {
  await renderCard();
  expect([...host.querySelectorAll("button")].map((entry) => entry.textContent)).toEqual([
    "Take control",
  ]);
  await act(async () => button("Take control")!.click());
  expect(onOpen).toHaveBeenCalledWith(false);
  expect(state.rpc).not.toHaveBeenCalled();
});

it("shows access denial on the card without keeping the previous preview", async () => {
  state.rpc.mockResolvedValueOnce(frame).mockRejectedValueOnce({ status: 403 });
  await renderCard("waiting");
  await act(async () => button("Skip")!.click());
  expect(host.textContent).toContain("You do not have access to this computer request");
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelectorAll("button")).toHaveLength(0);
});
