// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to verify the complete new mark stays within its frame.
// Inherited accessibility and theme checks remain Apache-2.0. New changes follow LICENSE.md.

// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => {
  function MockView(props: {
    children?: ReactNode;
    accessible?: boolean;
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: string;
    style?: { width?: number; height?: number; overflow?: string };
  }) {
    return createElement(
      "div",
      {
        "data-accessible": String(props.accessible),
        "aria-hidden": props.accessibilityElementsHidden ? "true" : undefined,
        "data-important": props.importantForAccessibility,
        "data-width": props.style?.width,
        "data-height": props.style?.height,
        "data-overflow": props.style?.overflow,
      },
      props.children,
    );
  }

  function MockImage(props: {
    resizeMode?: string;
    style?: { tintColor?: string; width?: number; height?: number; left?: number; top?: number };
  }) {
    return createElement("img", {
      "data-tint": props.style?.tintColor,
      "data-width": props.style?.width,
      "data-height": props.style?.height,
      "data-left": props.style?.left,
      "data-top": props.style?.top,
      "data-resize-mode": props.resizeMode,
    });
  }

  return {
    Image: MockImage,
    StyleSheet: { create: <T,>(styles: T) => styles },
    View: MockView,
  };
});

vi.mock("./native", () => ({
  native: { label: "label" },
  useThemedStyles: <T,>(factory: () => T) => factory(),
}));

import { AppMark } from "../components/app-mark";

describe("AppMark", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
  });

  it("is hidden from VoiceOver and TalkBack and tinted like text", () => {
    act(() => {
      root?.render(<AppMark />);
    });
    const mark = container?.querySelector("div");

    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(mark?.dataset.accessible).toBe("false");
    expect(mark?.dataset.important).toBe("no-hide-descendants");
    const image = container?.querySelector("img");
    expect(image?.dataset.tint).toBe("label");
    expect(image?.dataset.resizeMode).toBe("contain");
    expect(image?.dataset.width).toBe(mark?.dataset.width);
    expect(image?.dataset.height).toBe(mark?.dataset.height);
    expect(image?.dataset.left).toBeUndefined();
    expect(image?.dataset.top).toBeUndefined();
    expect(mark?.dataset.overflow).not.toBe("hidden");
  });
});
