// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { tokensForAppearance } from "@orkbot/ui-tokens";
import type { CSSProperties, ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThreadMessagesSkeleton } from "../components/thread/thread-messages-skeleton";

const animation = vi.hoisted(() => ({
  focused: true,
  foreground: true,
  reducedMotion: false,
  shared: undefined as { value: number } | undefined,
  cancel: vi.fn(),
  timing: vi.fn((value: number) => value),
  repeat: vi.fn((value: number) => value),
}));

type ViewProps = {
  children?: ReactNode;
  accessible?: boolean;
  accessibilityRole?: "progressbar";
  accessibilityLabel?: string;
  accessibilityState?: { busy?: boolean };
  accessibilityElementsHidden?: boolean;
  importantForAccessibility?: string;
  pointerEvents?: string;
  style?: unknown;
};

function flatten(style: unknown): CSSProperties {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return (style as CSSProperties) ?? {};
}

function View({
  children,
  accessible,
  accessibilityRole,
  accessibilityLabel,
  accessibilityState,
  accessibilityElementsHidden,
  importantForAccessibility,
  pointerEvents,
  style,
}: ViewProps) {
  return createElement(
    "div",
    {
      role: accessible ? accessibilityRole : undefined,
      "aria-label": accessibilityLabel,
      "aria-busy": accessibilityState?.busy,
      "aria-hidden": accessibilityElementsHidden || undefined,
      "data-accessibility": importantForAccessibility,
      "data-pointer-events": pointerEvents,
      style: flatten(style),
    },
    children,
  );
}

vi.mock("react-native", () => ({
  View,
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
vi.mock("react-native-reanimated", async () => {
  const { useState } = await import("react");
  return {
    default: { View },
    cancelAnimation: animation.cancel,
    withTiming: animation.timing,
    withRepeat: animation.repeat,
    useReducedMotion: () => animation.reducedMotion,
    useSharedValue: (value: number) => {
      const [shared] = useState(() => ({ value }));
      animation.shared = shared;
      return shared;
    },
    useAnimatedStyle: (style: () => unknown) => style(),
  };
});
vi.mock("expo-router", () => ({ useIsFocused: () => animation.focused }));
vi.mock("./app-foreground", () => ({ useAppForeground: () => animation.foreground }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("./native", () => ({ useMobileTokens: () => tokensForAppearance("light") }));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  animation.focused = true;
  animation.foreground = true;
  animation.reducedMotion = false;
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

function render() {
  act(() => root.render(<ThreadMessagesSkeleton />));
}

it("announces a single loading status and hides decorative placeholders", () => {
  render();
  const status = host.querySelector('[role="progressbar"]');
  expect(status?.getAttribute("aria-label")).toBe("Loading…");
  expect(status?.getAttribute("aria-busy")).toBe("true");
  expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
  expect(status?.getAttribute("data-pointer-events")).toBe("none");
  expect(status?.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  expect(status?.firstElementChild?.getAttribute("data-accessibility")).toBe("no-hide-descendants");
  expect(host.textContent).toBe("");
});

it("starts one subtle pulse and cancels it when unmounted", () => {
  render();
  expect(animation.timing).toHaveBeenCalledTimes(1);
  expect(animation.repeat).toHaveBeenCalledTimes(1);
  expect(animation.repeat).toHaveBeenCalledWith(0.6, -1, true);
  act(() => root.unmount());
  expect(animation.cancel).toHaveBeenCalledExactlyOnceWith(animation.shared);
  root = createRoot(host);
});

it.each(["reducedMotion", "foreground", "focused"] as const)(
  "keeps the skeleton still when motion is unavailable through %s",
  (mode) => {
    animation[mode] = mode === "reducedMotion";
    render();
    expect(animation.repeat).not.toHaveBeenCalled();
    expect(animation.shared?.value).toBe(1);
  },
);

it.each(["reducedMotion", "foreground", "focused"] as const)(
  "cancels and resumes a running pulse when %s changes",
  (mode) => {
    render();
    animation[mode] = mode === "reducedMotion";
    render();
    expect(animation.cancel).toHaveBeenCalledExactlyOnceWith(animation.shared);
    expect(animation.shared?.value).toBe(1);
    expect(animation.repeat).toHaveBeenCalledTimes(1);
    animation[mode] = mode !== "reducedMotion";
    render();
    expect(animation.repeat).toHaveBeenCalledTimes(2);
  },
);
