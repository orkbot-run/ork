// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to verify replacement Ork geometry.
// Inherited behavior checks remain Apache-2.0. New changes follow LICENSE.md.

// @vitest-environment jsdom

import {
  LOGO_AVATAR_ART_SCALE,
  LOGO_AVATAR_ART_TRANSFORM,
  LOGO_AVATAR_BODY_Y,
  LOGO_AVATAR_LIGHTING,
  logoAvatarEyeInk,
  logoAvatarFrame,
  logoAvatarTraits,
  ORK_AVATAR_BODY_PATHS,
  ORK_AVATAR_SATELLITES,
  orkAvatarAccessoryParts,
  orkAvatarCheekParts,
  orkAvatarEyeParts,
  orkAvatarMouthParts,
  seededLogoAvatarColor,
} from "@orkbot/core";
import type { ColorTokens } from "@orkbot/ui-tokens";
import { tokensForAppearance } from "@orkbot/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement, useRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotAvatarProps } from "../components/bot-avatar";
import { BotAvatar } from "../components/bot-avatar";
import { AvatarScreenFocus } from "./avatar-life";
import { mobileLogoAvatarActivity } from "./logo-avatar-activity";

const nativeProps = vi.hoisted(() => [] as Array<() => Record<string, unknown>>);
const mobileTokens = vi.hoisted(() => ({ current: undefined as ColorTokens | undefined }));
const nativeMotion = vi.hoisted(() => ({
  reduced: true,
  styles: [] as Array<() => { transform: unknown[] }>,
  timings: [] as number[],
}));

vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
    style,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    style?: { borderColor?: string; backgroundColor?: string };
  }) =>
    createElement(
      "div",
      {
        "aria-label": accessibilityLabel,
        "data-border": style?.borderColor,
        "data-background": style?.backgroundColor,
      },
      children,
    ),
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
  Pressable: ({
    children,
    onPress,
    accessible,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessible?: boolean;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, "data-accessible": String(accessible) },
      children,
    ),
  Image: ({ source }: { source: { uri: string } }) => createElement("img", { src: source.uri }),
}));

vi.mock("react-native-reanimated", () => {
  const passthrough = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    default: {
      View: passthrough,
      createAnimatedComponent: (component: unknown) => component,
    },
    cancelAnimation: () => undefined,
    Easing: { linear: (value: number) => value, inOut: (value: unknown) => value, cubic: 0 },
    ReduceMotion: { Never: "never" },
    withSpring: (value: unknown) => value,
    useAnimatedProps: (sample: () => Record<string, unknown>) => {
      nativeProps.push(sample);
      return { __sample: sample };
    },
    useDerivedValue: (sample: () => unknown) => ({ value: sample() }),
    useAnimatedStyle: (sample: () => { transform: unknown[] }) => {
      nativeMotion.styles.push(sample);
      return {};
    },
    useReducedMotion: () => nativeMotion.reduced,
    useSharedValue: <T,>(value: T) => useRef({ value }).current,
    withRepeat: (value: unknown) => value,
    withTiming: (value: unknown, options?: { duration: number }) => {
      const duration = options?.duration ?? 0;
      nativeMotion.timings.push(duration);
      return value === 1 && duration > 0 && duration < 1000 ? 0.4 : value;
    },
  };
});

vi.mock("react-native-svg", () => {
  const element =
    (tag: string) =>
    ({
      children,
      ...props
    }: {
      children?: ReactNode;
      d?: string;
      fill?: string;
      stopColor?: string;
      offset?: number | string;
      id?: string;
      stroke?: string;
      transform?: string;
      animatedProps?: { __sample: () => Record<string, unknown> };
    }) =>
      createElement(
        tag,
        {
          "data-d": props.d,
          "data-fill": props.fill,
          "data-stop-color": props.stopColor,
          "data-offset": props.offset,
          "data-offset-type": typeof props.offset,
          "data-id": props.id,
          "data-stroke": props.stroke,
          "data-transform": props.transform,
          "data-svg-props": JSON.stringify(props),
          "data-matrix": JSON.stringify(props.animatedProps?.__sample().matrix),
        },
        children,
      );
  return {
    default: element("svg"),
    Circle: element("circle"),
    Ellipse: element("ellipse"),
    G: element("g"),
    Path: element("path"),
    Rect: element("rect"),
    Defs: element("defs"),
    ClipPath: element("clipPath"),
    Mask: element("mask"),
    LinearGradient: element("linearGradient"),
    RadialGradient: element("radialGradient"),
    Stop: element("stop"),
  };
});

vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ color }: { color: string }) => createElement("i", { "data-color": color }),
}));
vi.mock("./native", () => ({
  useMobileTokens: () =>
    mobileTokens.current ?? {
      background: "#FFF",
      foreground: "#141414",
      sidebar: "#F1F1F1",
      border: "#CCCCCC",
      workingDot: "#3FA266",
      secondary: "#7676801F",
    },
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

describe("BotAvatar", () => {
  it("renders the thinking pose only while the production mobile store has a genuine marker", () => {
    mobileLogoAvatarActivity.hydrate("native-test", {
      threadId: "native-thread",
      cursor: 0,
      botId: "bot-1",
      run: { id: "native-run", botId: "bot-1", status: "running", trigger: "user" },
    });
    const view = render("#10B981", "orkbot");
    const latestEye = (): number[] =>
      JSON.parse(view.querySelector('g[data-id^="eyes-"]')!.getAttribute("data-matrix")!);
    const send = (seq: number, thinking: boolean) =>
      act(() =>
        mobileLogoAvatarActivity.apply("native-test", {
          threadId: "native-thread",
          seq,
          botId: "bot-1",
          runId: "native-run",
          type: "thread.meta",
          payload: { activity: { thinking } },
        }),
      );
    send(1, true);
    const frame = logoAvatarFrame("thinking", logoAvatarTraits("bot-1", "#10B981"), 0, true);
    const matrix = latestEye();
    const lid = frame.lid * frame.blink;
    expect(matrix[3]).toBe(lid);
    expect(matrix[4]! * LOGO_AVATAR_ART_SCALE).toBe(frame.eyeX);
    expect((matrix[5]! - 302 * (1 - lid)) * LOGO_AVATAR_ART_SCALE).toBeCloseTo(frame.eyeY);
    send(2, false);
    expect(latestEye()).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("uses the saved account seed with the local bot's activity subscription", () => {
    const seed = "64cf5621-3144-4810-97f5-148acdc29c35";
    mobileLogoAvatarActivity.hydrate("native-account-ork", {
      threadId: "native-thread",
      cursor: 0,
      botId: "bot-1",
      run: { id: "native-run", botId: "bot-1", status: "running", trigger: "user" },
    });
    const view = render("#10B981", "orkbot", { avatarSeed: seed });
    expect(bodies(view)).toContain(
      ORK_AVATAR_BODY_PATHS[logoAvatarTraits(seed, "#10B981").appearance.shape],
    );
    act(() =>
      mobileLogoAvatarActivity.apply("native-account-ork", {
        threadId: "native-thread",
        seq: 1,
        botId: "bot-1",
        runId: "native-run",
        type: "thread.meta",
        payload: { activity: { thinking: true } },
      }),
    );
    const frame = logoAvatarFrame("thinking", logoAvatarTraits(seed, "#10B981"), 0, true);
    const matrix = JSON.parse(
      view.querySelector('g[data-id^="eyes-"]')!.getAttribute("data-matrix")!,
    );
    expect(matrix[3]).toBe(frame.lid * frame.blink);
  });

  it("uses the same shared seed colour as SSR for a bot without a saved colour", () => {
    const node = render("", "orkbot");
    expect(
      node.querySelector(`stop[data-stop-color="${seededLogoAvatarColor("bot-1").toLowerCase()}"]`),
    ).not.toBeNull();
  });
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
    nativeProps.length = 0;
    nativeMotion.reduced = true;
    nativeMotion.styles.length = 0;
    nativeMotion.timings.length = 0;
    mobileLogoAvatarActivity.clear();
    mobileTokens.current = undefined;
  });

  function render(
    color: string,
    avatarSet?: "organic" | "orkbot",
    props: Partial<BotAvatarProps> = {},
    focused = true,
  ) {
    act(() => root?.unmount());
    container?.remove();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const avatar = (
      <BotAvatar color={color} avatarSet={avatarSet} identity="bot-1" size={42} {...props} />
    );
    act(() =>
      root?.render(
        focused ? (
          avatar
        ) : (
          <AvatarScreenFocus navigation={{ isFocused: () => false, addListener: () => () => {} }}>
            {avatar}
          </AvatarScreenFocus>
        ),
      ),
    );
    return container;
  }

  const bodies = (view: HTMLElement) =>
    Array.from(view.querySelectorAll("path"), (path) => path.dataset.d);

  it("preserves the shared native tap reactions on the Ork set", () => {
    nativeMotion.reduced = false;
    const view = render("#3EC5A8", "orkbot", { pokeable: true, motion: "running" });
    const button = view.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.dataset.accessible).toBe("false");
    act(() => button!.click());
    expect(nativeMotion.timings.filter((ms) => ms < 1000)).toEqual([800]);
    expect(nativeMotion.styles.at(-1)!().transform).not.toEqual([
      { translateY: 0 },
      { rotate: "0deg" },
      { scaleY: 1 },
    ]);
    act(() => button!.click());
    expect(nativeMotion.timings.filter((ms) => ms < 1000)).toEqual([800, 700]);
    expect(nativeMotion.timings.filter((ms) => ms >= 1000)).toEqual([24_000]);
  });

  it("settles an active tap when reduced motion becomes enabled", () => {
    nativeMotion.reduced = false;
    const view = render("#3EC5A8", "orkbot", { pokeable: true, motion: "running" });
    act(() => view.querySelector("button")!.click());
    nativeMotion.reduced = true;
    act(() =>
      root?.render(
        <BotAvatar
          color="#3EC5A8"
          avatarSet="orkbot"
          identity="bot-1"
          size={42}
          status="running"
          pokeable
          motion="running"
        />,
      ),
    );
    expect(nativeMotion.styles.at(-1)!().transform).toEqual([
      { translateY: 0 },
      { rotate: "0deg" },
      { scaleY: 1 },
    ]);
  });

  it.each(["reduced", "offscreen", "static"])("keeps tap motion still when %s", (condition) => {
    nativeMotion.reduced = condition === "reduced";
    const view = render(
      "#3EC5A8",
      "orkbot",
      { pokeable: true, motion: condition === "static" ? "static" : "running" },
      condition !== "offscreen",
    );
    const button = view.querySelector("button");
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(nativeMotion.timings.filter((ms) => ms > 0 && ms < 1000)).toEqual([]);
  });

  it.each([undefined, "organic", "orkbot"] as const)(
    "draws every non-photo bot with the Ork generator, including saved set %s",
    (avatarSet) => {
      const view = render("#3EC5A8", avatarSet);
      expect(bodies(view)).toContain(
        ORK_AVATAR_BODY_PATHS[logoAvatarTraits("bot-1", "#3EC5A8").appearance.shape],
      );
      expect(view.querySelector('g[data-id^="eyes-"]')).not.toBeNull();
      expect(view.querySelector("img")).toBeNull();
    },
  );

  it("keeps a picture", () => {
    const view = render("data:image/png;base64,abc");
    expect(view.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,abc");
    expect(bodies(view)).toEqual([]);
  });

  it("keeps a legacy shape's saved colour while drawing the Ork generator body", () => {
    const view = render("#123456::shape_3");
    expect(bodies(view)).toContain(
      ORK_AVATAR_BODY_PATHS[logoAvatarTraits("bot-1", "#123456").appearance.shape],
    );
    expect(view.querySelector('stop[data-stop-color="#123456"]')).not.toBeNull();
  });
  it("draws the explicitly selected Ork set as paths and gradients without a raster image", () => {
    const view = render("#3EC5A8", "orkbot");
    expect(bodies(view)).toContain(
      ORK_AVATAR_BODY_PATHS[logoAvatarTraits("bot-1", "#3EC5A8").appearance.shape],
    );
    expect(view.querySelector("img, image")).toBeNull();
    expect(view.querySelector('g[data-id^="eyes-"]')).not.toBeNull();
    expect(view.querySelector("radialGradient")).not.toBeNull();
  });

  it("keeps the clay gradients' middle stops at native numeric fractional positions", () => {
    const view = render("#3EC5A8", "orkbot");
    const middleStops = [
      view.querySelector("linearGradient stop:nth-child(2)"),
      view.querySelector("radialGradient stop:nth-child(2)"),
    ];
    expect(middleStops.map((stop) => stop?.getAttribute("data-offset"))).toEqual(["0.53", "0.4"]);
    // react-native-svg treats unsupported decimal strings as zero, changing the gradient.
    expect(middleStops.map((stop) => stop?.getAttribute("data-offset-type"))).toEqual([
      "number",
      "number",
    ]);
  });

  it("renders the generator's varied bodies, faces and accessories as the same native primitives", () => {
    const coverage = {
      shape: new Set<string>(),
      eyes: new Set<string>(),
      mouth: new Set<string>(),
      accessory: new Set<string>(),
      satellites: new Set<number>(),
      shine: new Set<boolean>(),
      cheeks: new Set<boolean>(),
    };
    for (let index = 0; index < 96; index++) {
      const identity = `native-variant-${index}`;
      const traits = logoAvatarTraits(identity, "#3EC5A8");
      const appearance = traits.appearance;
      const view = render("#3EC5A8", "orkbot", { identity });
      const ink = logoAvatarEyeInk(traits.color, { background: "#FFF", foreground: "#141414" });
      const expectedParts = [
        ...orkAvatarEyeParts(appearance.eyes, appearance.eyeSize, 0, ink),
        ...orkAvatarEyeParts(appearance.eyes, appearance.eyeSize, 1, ink),
        ...orkAvatarMouthParts(appearance.mouth, ink),
        ...orkAvatarAccessoryParts(appearance.accessory, "behind"),
        ...orkAvatarAccessoryParts(appearance.accessory, "front"),
        ...(appearance.cheeks ? orkAvatarCheekParts() : []),
      ];
      const actualParts = Array.from(
        view.querySelectorAll("path, ellipse, rect, circle"),
        (part) => ({
          tag: part.tagName.toLowerCase(),
          props: JSON.parse(part.getAttribute("data-svg-props")!),
        }),
      );
      for (const part of expectedParts)
        expect(actualParts).toContainEqual({
          tag: part.tag,
          props: expect.objectContaining(part.props),
        });
      expect(
        bodies(view).filter((path) => path === ORK_AVATAR_BODY_PATHS[appearance.shape]),
      ).toHaveLength(3);
      expect(bodies(view).includes(LOGO_AVATAR_LIGHTING.shine.path)).toBe(appearance.shine);
      const art = view.querySelector(`g[data-transform="${LOGO_AVATAR_ART_TRANSFORM}"]`)!;
      expect(art.parentElement?.getAttribute("data-transform")).toBe(
        `translate(0 ${LOGO_AVATAR_BODY_Y})`,
      );
      const satellites = actualParts.filter(
        (part) => part.tag === "circle" && String(part.props.fill).startsWith("url(#satellite-"),
      );
      expect(satellites.map(({ props }) => [props.cx, props.cy, props.r])).toEqual(
        ORK_AVATAR_SATELLITES.slice(0, appearance.satellites),
      );
      expect(view.querySelector("img, image, webview, foreignObject")).toBeNull();
      for (const key of ["shape", "eyes", "mouth", "accessory"] as const)
        coverage[key].add(appearance[key]);
      coverage.satellites.add(appearance.satellites);
      coverage.shine.add(appearance.shine);
      coverage.cheeks.add(appearance.cheeks);
    }
    expect([...coverage.shape].sort()).toEqual(Object.keys(ORK_AVATAR_BODY_PATHS).sort());
    expect(coverage.eyes.size).toBe(7);
    expect(coverage.mouth.size).toBe(7);
    expect(coverage.accessory.size).toBe(9);
    expect([...coverage.satellites].sort()).toEqual([0, 1, 2, 3, 4]);
    expect([...coverage.shine].sort()).toEqual([false, true]);
    expect([...coverage.cheeks].sort()).toEqual([false, true]);
  });

  it("keeps a custom picture when the stored set is Ork", () => {
    const view = render("data:image/png;base64,abc", "orkbot");
    expect(view.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,abc");
    expect(bodies(view)).toEqual([]);
  });

  it.each([
    "idle",
    "working",
    "reading",
    "writing",
    "thinking",
    "computer",
    "waiting",
    "error",
  ] as const)("updates varied native face geometry with finite matrices while %s", (activity) => {
    render("#3EC5A8", "orkbot", { activity });
    const updates = nativeProps.map((sample) => sample());
    const matrices = updates.flatMap((update) =>
      Array.isArray(update.matrix) ? [update.matrix] : [],
    );
    expect(matrices).toHaveLength(7);
    for (const matrix of matrices) {
      expect(matrix).toHaveLength(6);
      expect(matrix.every(Number.isFinite)).toBe(true);
    }
    expect(updates.filter((update) => "cx" in update)).toHaveLength(0);
    expect(updates.every((update) => !("transform" in update))).toBe(true);
  });

  it("keeps eyes legible on a saved dark body in the light theme", () => {
    const view = render("#101014", "orkbot");
    const eyes = view.querySelector('g[data-id^="eyes-"]')!;
    const ink = Array.from(eyes.querySelectorAll("path, ellipse, circle, rect"), (eye) =>
      eye.getAttribute("data-fill") === "none"
        ? eye.getAttribute("data-stroke")
        : eye.getAttribute("data-fill"),
    );
    expect(ink.length).toBeGreaterThanOrEqual(2);
    expect(ink.every((color) => color === "#FFF")).toBe(true);
  });

  it.each([
    ["light", "data:image/png;base64,abc"],
    ["dark", "data:image/png;base64,abc"],
    ["light", "#3EC5A8"],
    ["dark", "#3EC5A8"],
  ] as const)("draws the muted badge with the %s theme tokens for %s", (appearance, color) => {
    const tokens = tokensForAppearance(appearance);
    mobileTokens.current = tokens;
    const badge = render(color, undefined, { muted: true }).querySelector<HTMLElement>(
      '[aria-label="Notifications silenced"]',
    );
    // An opaque backing keeps the picture from showing through the translucent fill.
    expect(badge?.dataset).toMatchObject({
      border: tokens.background,
      background: tokens.background,
    });
    expect(badge?.querySelector<HTMLElement>("div")?.dataset.background).toBe(tokens.secondary);
    expect(badge?.querySelector("i")?.dataset.color).toBe(tokens.foreground);
  });
});
