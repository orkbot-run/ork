// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 badge, viewport and activity checks remain. Ork motion replaces legacy faces.

// @vitest-environment jsdom

import { AVATAR_POKES, avatarPokeFrame } from "@orkbot/core";
import type { ReactNode } from "react";
import { act, createElement, useRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActivityMark,
  MARK_SIZE,
  MARK_SPRING,
  ROW_HEIGHT,
  ROW_MS,
} from "../components/activity-mark";
import { BotAvatar } from "../components/bot-avatar";
import {
  AvatarRow,
  AvatarScreenFocus,
  AvatarViewportScope,
  createAvatarViewport,
} from "./avatar-life";

const CLOCK_MS = 24 * 60 * 60 * 1000;
const motion = vi.hoisted(() => ({
  reducedMotion: false,
  /** Every timing started: [target, duration]. */
  timings: [] as Array<[unknown, number]>,
  /** Every spring started: [target, config]. */
  springs: [] as Array<[unknown, Record<string, number> | undefined]>,
  cancelled: 0,
}));

vi.mock("react-native-reanimated", () => {
  const passthrough = ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement(
      "div",
      { "data-opacity": Object.assign({}, ...[style].flat()).opacity },
      children,
    );
  const easing = (value: unknown) => value;
  const fade = { duration: () => ({}) };
  return {
    default: { View: passthrough, createAnimatedComponent: () => passthrough },
    cancelAnimation: () => {
      motion.cancelled += 1;
    },
    Easing: { in: easing, out: easing, inOut: easing, quad: 0, cubic: 0, linear: 0 },
    FadeIn: fade,
    FadeOut: fade,
    ReduceMotion: { Never: "never" },
    useAnimatedProps: (worklet: () => unknown) => worklet(),
    useAnimatedStyle: (worklet: () => unknown) => worklet(),
    useReducedMotion: () => motion.reducedMotion,
    useDerivedValue: (worklet: () => unknown) => ({ value: worklet() }),
    withRepeat: (value: unknown) => value,
    useSharedValue: <T,>(value: T) => useRef({ value }).current,
    withSpring: (value: unknown, config?: Record<string, number>) => {
      motion.springs.push([value, config]);
      return value;
    },
    withTiming: (value: unknown, config?: { duration?: number }) => {
      motion.timings.push([value, config?.duration ?? 0]);
      return value;
    },
  };
});
vi.mock("react-native-svg", () => {
  const element = ({
    children,
    fill,
    stopColor,
  }: {
    children?: ReactNode;
    fill?: string;
    stopColor?: string;
  }) => createElement("div", { "data-fill": fill, "data-stop-color": stopColor }, children);
  return {
    default: element,
    Circle: element,
    Ellipse: element,
    G: element,
    Path: element,
    Rect: element,
    ClipPath: element,
    Defs: element,
    LinearGradient: element,
    RadialGradient: element,
    Stop: element,
  };
});
vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
    style,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    style?: { width?: number; backgroundColor?: string; borderColor?: string };
  }) =>
    createElement(
      "div",
      {
        "aria-label": accessibilityLabel,
        "data-width": style?.width,
        "data-bg": style?.backgroundColor,
        "data-ring": style?.borderColor,
      },
      children,
    ),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, children),
  Image: () => null,
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({
    foreground: "#141414",
    sidebar: "#EEE",
    border: "#CCC",
    mutedForeground: "#888",
    background: "#FFF",
    workingDot: "#3FA266",
    secondary: "#EEE",
  }),
}));

const SHAPE = "#2A92FE::shape_2";

describe("avatar motion on mobile", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    motion.reducedMotion = false;
    motion.timings = [];
    motion.springs = [];
    motion.cancelled = 0;
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const render = (node: ReactNode) => act(() => root.render(node));
  const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  const clockStarted = () => motion.timings.some(([, duration]) => duration === 24_000);
  const workingDot = () => container.querySelector('[aria-label="Working"]');

  it("keeps resting inbox avatars static and runs the Ork clock while busy", () => {
    render(<BotAvatar color={SHAPE} identity="bot-1" size={62} motion="lazy" />);
    wait(30_000);
    expect(clockStarted()).toBe(false);
    render(<BotAvatar color={SHAPE} identity="bot-1" size={62} status="running" motion="lazy" />);
    expect(clockStarted()).toBe(true);
    const cancelled = motion.cancelled;
    render(<BotAvatar color={SHAPE} identity="bot-1" size={62} status="completed" motion="lazy" />);
    expect(motion.cancelled).toBeGreaterThan(cancelled);
  });

  it("keeps a static busy avatar still and displays its working badge", () => {
    render(<BotAvatar color={SHAPE} identity="bot-1" size={28} status="running" />);
    wait(30_000);
    expect(clockStarted()).toBe(false);
    expect(workingDot()).not.toBeNull();
  });

  it("draws the working badge in the surface colour at the avatar's size", () => {
    render(<BotAvatar color={SHAPE} identity="bot-1" size={62} status="running" motion="lazy" />);
    expect(workingDot()?.getAttribute("data-bg")).toBe("#3FA266");
    expect(workingDot()?.getAttribute("data-ring")).toBe("#FFF");
    expect(Number(workingDot()?.getAttribute("data-width"))).toBeCloseTo(12 + 2 * 62 * 0.046);
  });

  it("leaves the working badge off writing and activity avatars", () => {
    render(<BotAvatar color={SHAPE} identity="bot-1" size={28} status="running" composing />);
    expect(workingDot()).toBeNull();
    render(
      <BotAvatar color={SHAPE} identity="bot-1" size={28} status="running" motion="running" />,
    );
    expect(workingDot()).toBeNull();
  });

  it.each(["reduced", "tiny", "photo"])(
    "does not allocate the continuous Ork clock for %s",
    (condition) => {
      motion.reducedMotion = condition === "reduced";
      render(
        <BotAvatar
          color={condition === "photo" ? "data:image/png;base64,AAAA" : SHAPE}
          identity="bot-1"
          size={condition === "tiny" ? 23 : 62}
          status="running"
          motion="lazy"
        />,
      );
      expect(clockStarted()).toBe(false);
    },
  );

  it("holds a photo's place with a plain circle while it loads", () => {
    render(<BotAvatar color="data:image/png;base64,AAAA" identity="bot-p" size={28} />);
    expect(container.querySelector('[data-bg="#EEE"]')?.getAttribute("data-width")).toBe("28");
  });

  it("starts an Ork clock only after its list row enters the viewport", () => {
    const viewport = createAvatarViewport();
    render(
      <AvatarViewportScope viewport={viewport}>
        <AvatarRow id="bot-1">
          <BotAvatar color={SHAPE} identity="bot-1" size={62} status="running" motion="lazy" />
        </AvatarRow>
      </AvatarViewportScope>,
    );
    expect(clockStarted()).toBe(false);
    act(() => viewport.update(["bot-1"]));
    expect(clockStarted()).toBe(true);
  });

  it("waits for the screen to become focused before starting motion", () => {
    let focused = false;
    const listeners = new Set<() => void>();
    const navigation = {
      isFocused: () => focused,
      addListener: (_event: "focus" | "blur", listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    render(
      <AvatarScreenFocus navigation={navigation}>
        <BotAvatar color={SHAPE} identity="bot-1" size={62} status="running" motion="lazy" />
      </AvatarScreenFocus>,
    );
    expect(clockStarted()).toBe(false);
    focused = true;
    act(() => {
      for (const listener of listeners) listener();
    });
    expect(clockStarted()).toBe(true);
  });
});

describe("activity mark", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    motion.reducedMotion = false;
    motion.timings = [];
    motion.springs = [];
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const render = (node: ReactNode) => act(() => root.render(node));
  const bots = [
    { id: "bot-a", color: SHAPE, status: "running" },
    { id: "bot-b", color: "#FF781C", status: "running" },
  ];
  const grewIn = () => motion.springs.some(([, config]) => config === MARK_SPRING);

  it("opens its row and grows in only once the chat is at the newest message", () => {
    render(<ActivityMark bots={bots.slice(0, 1)} atBottom={false} />);
    expect(motion.timings).toContainEqual([ROW_HEIGHT, ROW_MS]);
    expect(grewIn()).toBe(false);
    render(<ActivityMark bots={bots.slice(0, 1)} atBottom />);
    expect(grewIn()).toBe(true);
  });

  it("shows each working member of a group in turn, every 2 s", () => {
    render(<ActivityMark bots={bots} atBottom />);
    const shown = () =>
      container.querySelectorAll("[data-stop-color]")[1]?.getAttribute("data-stop-color");
    expect(shown()).toBe("#2a92fe");
    act(() => vi.advanceTimersByTime(2000));
    expect(shown()).toBe("#ff781c");
  });

  it("stops cycling members and pulsing photo dots on a covered screen, and resumes on return", () => {
    let focused = false;
    const listeners = new Set<() => void>();
    const navigation = {
      isFocused: () => focused,
      addListener: (_event: "focus" | "blur", listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const photo = { id: "bot-p", color: "data:image/png;base64,AAAA", status: "running" };
    const pulsing = () => motion.timings.some(([, duration]) => duration === CLOCK_MS);
    render(
      <AvatarScreenFocus navigation={navigation}>
        <ActivityMark bots={[photo, bots[0]!]} atBottom />
      </AvatarScreenFocus>,
    );
    const drawnShown = () => container.querySelector("[data-fill]") !== null;
    act(() => vi.advanceTimersByTime(6000));
    expect(drawnShown()).toBe(false);
    expect(pulsing()).toBe(false);
    focused = true;
    act(() => {
      for (const listener of listeners) listener();
    });
    expect(pulsing()).toBe(true);
    act(() => vi.advanceTimersByTime(2000));
    expect(drawnShown()).toBe(true);
  });

  it("holds still on the first member under Reduce Motion and appears at once", () => {
    motion.reducedMotion = true;
    render(<ActivityMark bots={bots} atBottom />);
    const first = container.innerHTML;
    act(() => vi.advanceTimersByTime(6000));
    expect(container.innerHTML).toBe(first);
    expect(grewIn()).toBe(false);
  });

  it("leaves room around the clipped Ork plate for the shared tap reactions", () => {
    const lift = (translateY: number, scaleY: number) =>
      (-translateY + (scaleY - 1) / 2) * MARK_SIZE;
    let tap = 0;
    for (const poke of AVATAR_POKES)
      for (let p = 0; p <= 1; p += 0.005) {
        const frame = avatarPokeFrame(poke, p);
        tap = Math.max(tap, lift(frame.translateY, frame.scaleY));
      }
    expect(tap).toBeGreaterThan(3);
    expect(tap).toBeLessThanOrEqual((ROW_HEIGHT - MARK_SIZE) / 2);
  });

  it("stays tappable for its reaction (the poke curves are tested in core)", () => {
    render(<ActivityMark bots={bots.slice(0, 1)} atBottom />);
    const tap = () => act(() => container.querySelector("button")?.click());
    // Pokes land on the avatar's shared value; the button stays tappable throughout.
    tap();
    tap();
    tap();
    expect(container.querySelector("button")).not.toBeNull();
  });

  it("keeps the generated Ork character while its bot writes", () => {
    render(<ActivityMark bots={[{ ...bots[0]!, composing: true }]} atBottom />);
    expect(container.querySelector("[data-stop-color]")).not.toBeNull();
    expect(container.querySelector('[aria-label="Working"]')).toBeNull();
  });

  it("shows plain typing dots instead of a photo, including a photo member's turn in a group", () => {
    const photo = { id: "bot-p", color: "data:image/png;base64,AAAA", status: "running" };
    const dots = () => container.querySelectorAll("[data-opacity]").length;
    render(<ActivityMark bots={[photo, bots[0]!]} atBottom />);
    expect(dots()).toBe(3);
    expect(container.querySelector("button")).toBeNull();
    act(() => vi.advanceTimersByTime(2000));
    expect(container.querySelector("[data-fill]")).not.toBeNull();
    act(() => vi.advanceTimersByTime(2000));
    expect(dots()).toBe(3);
  });
});
