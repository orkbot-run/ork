// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HapticsSetting } from "../components/haptics-setting";

const fake = vi.hoisted(() => ({
  value: undefined as boolean | undefined,
  listeners: new Set<() => void>(),
  load: vi.fn(),
  save: vi.fn(),
  alert: vi.fn(),
  selection: vi.fn(),
}));
vi.mock("./haptics", () => ({
  getHapticsEnabled: () => fake.value,
  subscribeHaptics: (listener: () => void) => {
    fake.listeners.add(listener);
    return () => {
      fake.listeners.delete(listener);
    };
  },
  loadHapticsEnabled: fake.load,
  saveHapticsEnabled: fake.save,
  selectionHaptic: fake.selection,
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (value: string) => value }) }));
vi.mock("react-native", () => ({ Alert: { alert: fake.alert } }));
vi.mock("../components/settings-group", () => ({
  SettingsSwitch: (props: {
    label: string;
    value: boolean;
    disabled: boolean;
    onChange: (value: boolean) => void;
  }) =>
    createElement("input", {
      type: "checkbox",
      "aria-label": props.label,
      checked: props.value,
      disabled: props.disabled,
      onChange: (event) => props.onChange(event.currentTarget.checked),
    }),
}));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let mounted: boolean;
const update = (value: boolean) => {
  fake.value = value;
  fake.listeners.forEach((listener) => {
    listener();
  });
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.value = undefined;
  fake.alert.mockReset();
  fake.selection.mockReset();
  fake.load.mockReset().mockImplementation(async () => {
    update(false);
    return false;
  });
  fake.save.mockReset().mockImplementation(async (value: boolean) => {
    update(value);
  });
  host = document.createElement("div");
  root = createRoot(host);
  mounted = true;
});
afterEach(() => {
  if (mounted) act(() => root.unmount());
  expect(fake.listeners.size).toBe(0);
  vi.unstubAllGlobals();
});
it("keeps an unhydrated switch disabled, then saves local opt-in without haptic duplication", async () => {
  let hydrate!: () => void;
  fake.load.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        hydrate = () => {
          update(false);
          resolve(false);
        };
      }),
  );
  act(() => root.render(createElement(HapticsSetting)));
  const input = host.querySelector("input")!;
  expect(input.disabled).toBe(true);
  await act(async () => hydrate());
  expect(input.disabled).toBe(false);
  expect(input.checked).toBe(false);
  await act(async () => input.click());
  expect(fake.save).toHaveBeenCalledExactlyOnceWith(true);
  expect(input.checked).toBe(true);
  expect(fake.selection).not.toHaveBeenCalled();
});
it("shows the existing native error only when a local write fails", async () => {
  fake.save.mockRejectedValueOnce(new Error("locked"));
  await act(async () => root.render(createElement(HapticsSetting)));
  await act(async () => host.querySelector("input")?.click());
  expect(fake.alert).toHaveBeenCalledExactlyOnceWith("Something went wrong. Try again.");
  expect(host.querySelector("input")?.checked).toBe(false);
  expect(host.querySelector("input")?.disabled).toBe(false);
});
it("does not show a late save error after the settings row unmounts", async () => {
  let fail!: (error: Error) => void;
  fake.save.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      }),
  );
  await act(async () => root.render(createElement(HapticsSetting)));
  act(() => host.querySelector("input")?.click());
  act(() => {
    root.unmount();
    mounted = false;
  });
  await act(async () => fail(new Error("locked")));
  expect(fake.alert).not.toHaveBeenCalled();
});
