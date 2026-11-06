// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 code remains separately licensed. Generator-only avatar editing is an Ork addition.

import type { BotAvatarSet } from "@orkbot/contracts";
import { DEFAULT_BOT_AVATAR_COLOR } from "@orkbot/ui-web";
import type { ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { AvatarStudioPopover } from "./avatar-studio-popover";

let container: HTMLDivElement;
let root: Root;
const changed = vi.fn<(value: string, avatarSet?: BotAvatarSet) => void>();

function Harness({
  value: initial,
  avatarSet: initialSet,
}: {
  value: string;
  avatarSet?: BotAvatarSet;
}) {
  const [value, setValue] = useState(initial);
  const [avatarSet, setAvatarSet] = useState(initialSet);
  return (
    <AvatarStudioPopover
      value={value}
      identity="sample-bot"
      avatarSet={avatarSet}
      onChange={(next, nextSet) => {
        changed(next, nextSet);
        setValue(next);
        if (nextSet !== undefined) setAvatarSet(nextSet);
      }}
    />
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  changed.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function button(name: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.getAttribute("aria-label") === name || node.textContent === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function render(value: string, avatarSet?: BotAvatarSet, key = "initial") {
  await act(async () => root.render(<Harness key={key} value={value} avatarSet={avatarSet} />));
}

describe("generator-only bot appearances", () => {
  it("opens the generator without a legacy set or manual shape selector", async () => {
    await render("#10B981");
    await click("Customize bot avatar");
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent);
    expect(tabs).toEqual(["Bot", "Upload"]);
    expect(document.querySelector(".orkbot-logo-avatar")).not.toBeNull();
    expect(document.querySelector(".orkbot-organic-avatar")).toBeNull();
    expect(document.querySelector('[aria-label="wedge"]')).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });

  it("leaves a photo intact until an explicit reset or color selection", async () => {
    const photo = "data:image/png;base64,abc";
    await render(photo);
    expect(document.querySelector(`img[src="${photo}"]`)).not.toBeNull();
    await click("Customize bot avatar");
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector(`img[src="${photo}"]`)).not.toBeNull();
    await click("Reset");
    expect(changed).toHaveBeenLastCalledWith(DEFAULT_BOT_AVATAR_COLOR, undefined);
    expect(document.querySelector(`img[src="${photo}"]`)).toBeNull();
    expect(document.querySelector(".orkbot-logo-avatar")).not.toBeNull();
  });

  it("keeps a saved legacy value unchanged on open and saves only its new color when edited", async () => {
    await render("#8B5CF6::shape_2", "organic");
    await click("Customize bot avatar");
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector(".orkbot-logo-avatar")).not.toBeNull();
    await click("Color #00C972");
    expect(changed).toHaveBeenLastCalledWith("#00C972", undefined);
    expect(document.querySelector('[aria-label="Icon set"]')).toBeNull();
  });
});
