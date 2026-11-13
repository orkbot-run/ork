// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// @vitest-environment jsdom

import type { ComputerFrame } from "@orkbot/contracts";
import type { ReactNode } from "react";
import { act, createElement, createRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type {
  GestureResponderEvent,
  LayoutChangeEvent,
  PanResponderCallbacks,
  PanResponderGestureState,
} from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeComputerScreenControls } from "../components/native-computer-screen";
import { NativeComputerScreen } from "../components/native-computer-screen";

const state = vi.hoisted(() => ({
  scope: "scope-a" as string | null,
  rpc: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  gestures: {} as PanResponderCallbacks,
  layout: undefined as ((event: LayoutChangeEvent) => void) | undefined,
}));
vi.mock("./api", () => ({
  nativeInstallationScope: () => state.scope,
  captureApiRequestContext: async () => ({
    apiBase: "https://installation.example.test",
    sessionGeneration: 1,
    headers: {},
  }),
  rpc: state.rpc,
}));
vi.mock("./native", () => ({
  useMobileTokens: () => ({ card: "white", mutedForeground: "gray" }),
}));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text }),
}));
vi.mock("react-native", () => ({
  View: ({
    children,
    onLayout,
  }: {
    children?: ReactNode;
    onLayout?: (event: LayoutChangeEvent) => void;
  }) => {
    if (onLayout) state.layout = onLayout;
    return createElement("div", null, children);
  },
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  Image: ({
    accessibilityLabel,
    source,
  }: {
    accessibilityLabel: string;
    source: { uri: string };
  }) => createElement("img", { alt: accessibilityLabel, src: source.uri }),
  PanResponder: {
    create: (gestures: PanResponderCallbacks) => {
      state.gestures = gestures;
      return { panHandlers: {} };
    },
  },
}));

const frame: ComputerFrame = {
  id: "a".repeat(64),
  capturedAt: "2026-11-13T10:00:00.000Z",
  data: "AQID",
  mimeType: "image/png",
  width: 100,
  height: 80,
};
let root: Root;
let host: HTMLDivElement;
const controls = createRef<NativeComputerScreenControls>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.scope = "scope-a";
  state.rpc
    .mockReset()
    .mockImplementation(async (procedure, input) =>
      procedure === "computer/input"
        ? { ok: true }
        : (input as { previous?: string }).previous
          ? null
          : frame,
    );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(foreground = true) {
  await act(async () =>
    root.render(
      <NativeComputerScreen
        botId="bot-a"
        interactive
        foreground={foreground}
        controls={controls}
      />,
    ),
  );
}

it("renders only scoped HTTP image bytes and sends native keyboard input through the same captured context", async () => {
  await render();
  expect(host.querySelector("img")?.src).toBe("data:image/png;base64,AQID");
  await act(async () => controls.current?.keyboard({ type: "text", text: "Hello 👋" }));
  expect(state.rpc).toHaveBeenCalledWith(
    "computer/input",
    { botId: "bot-a", kind: "clipboard", payload: { text: "Hello 👋" } },
    {
      requestContext: {
        apiBase: "https://installation.example.test",
        sessionGeneration: 1,
        headers: {},
      },
    },
  );
});

it("hides the old image and discards a late response when the workspace or session changes", async () => {
  const releases: ((value: ComputerFrame) => void)[] = [];
  state.rpc.mockImplementation(
    () => new Promise<ComputerFrame>((resolve) => releases.push(resolve)),
  );
  await render();
  const oldControls = controls.current;
  state.scope = "scope-b";
  await render();
  await act(async () => {
    releases[0]!(frame);
    oldControls?.keyboard({ type: "key", name: "Return" });
  });
  expect(host.querySelector("img")).toBeNull();
  expect(state.rpc.mock.calls.every((call) => call[0] === "computer/frame")).toBe(true);
  await act(async () => releases[1]!({ ...frame, id: "b".repeat(64), data: "BAUG" }));
  expect(host.querySelector("img")?.src).toBe("data:image/png;base64,BAUG");
  state.scope = null;
  await render();
  expect(host.querySelector("img")).toBeNull();
});

it("cancels capture in the background and fences already queued input after a scope change", async () => {
  await render();
  const signal = (state.rpc.mock.calls[0]![2] as { signal: AbortSignal }).signal;
  let release!: () => void;
  state.rpc.mockImplementation(async (procedure) => {
    if (procedure === "computer/input")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return { ok: true };
  });
  await act(async () => {
    controls.current?.keyboard({ type: "key", name: "Return" });
    controls.current?.keyboard({ type: "key", name: "Tab" });
  });
  expect(state.rpc.mock.calls.filter((call) => call[0] === "computer/input")).toHaveLength(1);
  state.scope = "scope-b";
  await render(false);
  expect(signal.aborted).toBe(true);
  await act(async () => release());
  expect(host.querySelector("img")).toBeNull();
  expect(state.rpc.mock.calls.filter((call) => call[0] === "computer/input")).toHaveLength(1);
});

it("clears the image and stops reads when the server refuses authority", async () => {
  await render();
  state.rpc.mockRejectedValue(new Error("Forbidden"));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("Forbidden");
  const calls = state.rpc.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(state.rpc).toHaveBeenCalledTimes(calls);
});

it("maps touch coordinates and coalesces a drag while preserving its final release", async () => {
  await render();
  state.layout?.({ nativeEvent: { layout: { width: 200, height: 160 } } } as LayoutChangeEvent);
  const touch = (x: number, y: number) =>
    ({ nativeEvent: { locationX: x, locationY: y } }) as GestureResponderEvent;
  const gesture = { numberActiveTouches: 1 } as PanResponderGestureState;
  let release!: () => void;
  state.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true });
      }),
  );
  await act(async () => state.gestures.onPanResponderGrant?.(touch(20, 30), gesture));
  await act(async () => {
    for (let index = 0; index < 100; index++)
      state.gestures.onPanResponderMove?.(touch(index, index), gesture);
    state.gestures.onPanResponderRelease?.(touch(100, 110), gesture);
  });
  expect(state.rpc.mock.calls.filter((call) => call[0] === "computer/input")).toHaveLength(1);
  await act(async () => release());
  expect(
    state.rpc.mock.calls.filter((call) => call[0] === "computer/input").map((call) => call[1]),
  ).toEqual([
    { botId: "bot-a", kind: "pointer", payload: { type: "down", x: 10, y: 15, button: "left" } },
    { botId: "bot-a", kind: "pointer", payload: { type: "move", x: 50, y: 55, button: "left" } },
    { botId: "bot-a", kind: "pointer", payload: { type: "up", x: 50, y: 55, button: "left" } },
  ]);
});
