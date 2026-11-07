// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited page behavior is preserved. Legacy public link cleanup follows LICENSE.md.

// @vitest-environment jsdom

import type { OrkDesktop } from "@orkbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PageView } from "./PageView";

const frame = vi.hoisted(() => ({ drawn: undefined as (() => void) | undefined }));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./PageFrame", () => ({
  PageFrame: ({ onHeight }: { onHeight: () => void }) => {
    frame.drawn = onHeight;
    return <iframe title="page" />;
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.orkbotDesktop;
  document.body.replaceChildren();
});

type ViewProps = {
  document: string;
  open?: boolean;
  compact?: boolean;
  onOpenChange?: (open: boolean) => void;
  returnFocus?: () => boolean;
};

function mount(props: ViewProps) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const render = (next: typeof props) =>
    act(async () =>
      root.render(
        <PageView
          open={next.open ?? true}
          compact={next.compact}
          returnFocus={next.returnFocus}
          onRename={() => {}}
          onOpenChange={next.onOpenChange ?? (() => {})}
          title="Plan"
          document={next.document}
          access={<button type="button">Stop sharing</button>}
        />,
      ),
    );
  return { render, unmount: () => act(() => root.unmount()) };
}

it("waits for an updated page to draw, and offers a retry when it never does", async () => {
  vi.useFakeTimers();
  const view = mount({ document: "<p>v1</p>" });
  await view.render({ document: "<p>v1</p>" });
  await act(async () => frame.drawn?.());
  expect(document.body.textContent).not.toContain("This page couldn't load");

  await view.render({ document: "<p>v2</p>" });
  await act(async () => vi.advanceTimersByTime(16_000));
  expect(document.body.textContent).toContain("This page couldn't load");
  await view.unmount();
});

it("closes on Escape unless the key landed in a popup", async () => {
  const onOpenChange = vi.fn();
  const view = mount({ document: "<p>v1</p>", onOpenChange });
  await view.render({ document: "<p>v1</p>", onOpenChange });
  // A menu elsewhere in the app, open but not where the key went.
  const menu = document.body.appendChild(document.createElement("div"));
  menu.dataset.slot = "dropdown-menu-content";
  const press = (target: Element) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
  await press(document.querySelector('[data-testid="page-view"]')!);
  expect(onOpenChange).toHaveBeenLastCalledWith(false);

  onOpenChange.mockClear();
  const item = menu.appendChild(document.createElement("button"));
  await press(item);
  expect(onOpenChange).not.toHaveBeenCalled();
  await view.unmount();
});

it.each([
  ["darwin", false, true],
  ["darwin", true, true],
  ["win32", true, false],
  ["linux", true, false],
  [undefined, false, false],
] as const)(
  "reserves native chrome on the first %s render (frame %s)",
  async (platform, nativeWindowFrame, inset) => {
    if (platform) window.orkbotDesktop = { platform, nativeWindowFrame } as OrkDesktop;
    const view = mount({ document: "<p>v1</p>" });
    await view.render({ document: "<p>v1</p>" });
    const close = document.querySelector('[aria-label="Close page"]')!;
    expect(close.parentElement!.classList.contains("top-10")).toBe(inset);
    for (const control of [
      close,
      document.querySelector('[data-slot="dialog-title"]')!,
      document.querySelector("iframe")!.parentElement!.parentElement!,
    ]) {
      expect(control.closest(".app-no-drag")).not.toBeNull();
    }
    expect(
      [...document.querySelectorAll("button")]
        .find((node) => node.textContent === "Stop sharing")!
        .closest(".app-no-drag"),
    ).not.toBeNull();
    await view.unmount();
  },
);

it("keeps the backdrop through the page exit and disables both animations for reduced motion", async () => {
  const view = mount({ document: "<p>v1</p>" });
  await view.render({ document: "<p>v1</p>" });
  const popup = document.querySelector('[data-testid="page-view"]')!;
  const backdrop = document.querySelector('[data-slot="dialog-overlay"]')!;
  expect(popup.classList.contains("data-closed:duration-150")).toBe(true);
  expect(backdrop.classList.contains("data-closed:duration-150")).toBe(true);
  for (const layer of [popup, backdrop]) {
    for (const state of ["open", "closed"]) {
      expect(layer.classList.contains(`motion-reduce:data-${state}:animate-none`)).toBe(true);
    }
  }
  await view.unmount();
});

it.each(["button", "Escape"])("returns focus to its caller when closed by %s", async (method) => {
  const caller = document.body.appendChild(document.createElement("button"));
  const restore = vi.fn(() => {
    caller.focus();
    return false;
  });
  const view = mount({ document: "<p>v1</p>" });
  const props = { document: "<p>v1</p>", returnFocus: restore };
  const onOpenChange = vi.fn();
  await view.render({ ...props, onOpenChange });
  await act(async () => {
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close page"]')!;
    if (method === "button") close.click();
    else close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
  await view.render({ ...props, open: false });
  expect(restore).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(caller);
  await view.unmount();
});

it("keeps a reopened page when the previous exit finishes, and waits for its new document", async () => {
  vi.useFakeTimers();
  let finishExit!: () => void;
  const finished = new Promise<void>((resolve) => {
    finishExit = resolve;
  });
  const previous = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value(this: Element) {
      return this.hasAttribute("data-closed") ? [{ finished }] : [];
    },
  });
  const view = mount({ document: "<p>v1</p>" });
  try {
    await view.render({ document: "<p>v1</p>" });
    await act(async () => frame.drawn?.());
    await act(async () => vi.advanceTimersByTimeAsync(50));
    await view.render({ document: "<p>v1</p>", open: false });
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(document.querySelector('[data-testid="page-view"][data-closed]')).not.toBeNull();
    expect(document.querySelector('[data-slot="dialog-overlay"]')).not.toBeNull();

    await view.render({ document: "<p>v2</p>" });
    await act(async () => {
      finishExit();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(document.querySelector('[data-testid="page-view"][data-open]')).not.toBeNull();
    expect(document.querySelector("iframe")!.parentElement!.classList.contains("opacity-0")).toBe(
      true,
    );
    await act(async () => frame.drawn?.());
    expect(document.querySelector("iframe")!.parentElement!.classList.contains("opacity-100")).toBe(
      true,
    );
  } finally {
    await view.unmount();
    if (previous) Object.defineProperty(Element.prototype, "getAnimations", previous);
    else Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
});
