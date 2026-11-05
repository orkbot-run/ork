// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// @vitest-environment jsdom

import type { SpendingLimitState } from "@orkbot/contracts";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpendingLimitSettings } from "../components/spending-limit-settings";

const state = vi.hoisted(() => ({ rpc: vi.fn(), refocus: () => undefined as unknown }));
vi.mock("./api", () => ({ rpc: state.rpc }));
vi.mock("./i18n", () => {
  const i18n = { t: (text: string) => text };
  return { useI18n: () => i18n };
});
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./user-error", () => ({ errorText: (err: Error) => err.message }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    state.refocus = effect;
    useEffect(effect, [effect]);
  },
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("p", { role: "alert" }, children),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) =>
    createElement("section", null, children),
  SettingsInputRow: ({
    accessibilityLabel,
    value,
    onChangeText,
    editable,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
    editable: boolean;
  }) =>
    createElement("input", {
      "aria-label": accessibilityLabel,
      value,
      disabled: !editable,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
  SettingsRow: ({
    title,
    value,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    title: string;
    value?: string;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) =>
    onPress
      ? createElement(
          "button",
          { type: "button", onClick: onPress, disabled, "aria-label": accessibilityLabel },
          `${title}${value ? `: ${value}` : ""}`,
        )
      : createElement("span", null, `${title}: ${value}`),
}));
vi.mock("../components/menu-picker", () => ({
  MenuPickerMenu: ({
    label,
    choices,
    value,
    onChange,
    disabled,
  }: {
    label: string;
    choices: { key: string; label: string }[];
    value: string;
    onChange: (value: string) => void;
    disabled: boolean;
  }) =>
    createElement(
      "select",
      {
        "aria-label": label,
        value,
        disabled,
        onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      },
      choices.map((choice) =>
        createElement("option", { key: choice.key, value: choice.key }, choice.label),
      ),
    ),
}));

let root: Root;
let container: HTMLDivElement;
const button = (text: string) =>
  [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === text || entry.getAttribute("aria-label") === text,
  )!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.rpc
    .mockReset()
    .mockImplementation(async (proc: string, input?: { limit: SpendingLimitState["limit"] }) => {
      if (proc === "spendingLimit/get") return { limit: null, spent: 0 };
      if (proc === "spendingLimit/set") return { limit: input!.limit, spent: 0 };
      throw new Error(`Unexpected RPC: ${proc}`);
    });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(createElement(SpendingLimitSettings)));

async function enterAmount(value: string) {
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(label: string, value: string) {
  const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("saves a PLN limit including decimal comma and removes it for the whole account", async () => {
  await render();
  expect(state.rpc).toHaveBeenCalledWith("spendingLimit/get", {});
  await act(async () => button("Spending limit").click());
  await enterAmount("150,50");
  await choose("Currency", "PLN");
  await choose("Reset period (UTC)", "weekly");
  await act(async () => button("Save limit").click());
  expect(state.rpc).toHaveBeenCalledWith("spendingLimit/set", {
    limit: { amount: 150.5, currency: "PLN", period: "weekly" },
  });
  expect(container.textContent).toContain("PLN 150.50 · Weekly");
  await act(async () => button("Remove limit").click());
  expect(state.rpc).toHaveBeenLastCalledWith("spendingLimit/set", { limit: null });
  expect(container.textContent).toContain("No limit");
});

it("rejects invalid amounts locally and keeps a failed edit available", async () => {
  await render();
  await act(async () => button("Spending limit").click());
  for (const value of ["", "-1", "2.001", "1e3", "abc"]) {
    await enterAmount(value);
    expect(button("Save limit").disabled).toBe(true);
  }
  await enterAmount("0");
  expect(button("Save limit").disabled).toBe(false);
  state.rpc.mockRejectedValueOnce(new Error("Could not save spending limit"));
  await act(async () => button("Save limit").click());
  expect(container.querySelector("input")?.value).toBe("0");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not save spending limit",
  );
  expect(button("Save limit").disabled).toBe(false);
});

it("offers retry after a load failure", async () => {
  state.rpc.mockRejectedValueOnce(new Error("Offline"));
  await render();
  expect(button("Spending limit").disabled).toBe(true);
  expect(container.textContent).toContain("Offline");
  await act(async () => button("Retry").click());
  expect(button("Spending limit").disabled).toBe(false);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("keeps a saved limit when an older focus refresh finishes", async () => {
  state.rpc.mockResolvedValueOnce({
    limit: { amount: 5, currency: "USD", period: "never" },
    spent: 1,
  });
  await render();
  let resolveRead: (value: SpendingLimitState) => void = () => undefined;
  state.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );
  await act(async () => state.refocus());
  await act(async () => button("Spending limit").click());
  await enterAmount("10");
  await act(async () => button("Save limit").click());
  await act(async () =>
    resolveRead({ limit: { amount: 5, currency: "USD", period: "never" }, spent: 1 }),
  );
  expect(container.textContent).toContain("USD 10.00");
});
