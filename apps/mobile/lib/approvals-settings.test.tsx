// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved. Catalog and scoped-editor regressions follow LICENSE.md.
// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import Approvals from "../app/(settings)/approvals";

type Rule = {
  id: string;
  effect: "always_allow" | "require_approval" | "deny";
  matchKind: "tool" | "connector" | "category" | "site";
  matchValue: string;
  createdAt: string;
};
const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  spaceId: undefined as string | undefined,
  settings: { mode: "ask", enabled: false, skipApprovals: false, checkerAvailable: false },
  rules: [] as Rule[],
  headerItems: [] as { label: string; onPress: () => void }[],
  tool: undefined as string | undefined,
  setParams: vi.fn(),
  leftItems: [] as { label: string; onPress: () => void }[],
  search: undefined as
    | undefined
    | {
        onChangeText: (event: { nativeEvent: { text: string } }) => void;
        onCancelButtonPress: () => void;
      },
}));
const { element } = vi.hoisted(() => ({
  element:
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children),
}));

vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./i18n", () => {
  const i18n = { t: (text: string) => text };
  return { useI18n: () => i18n };
});
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./api", () => ({
  rpc: state.rpc,
  captureApiRequestContext: async (spaceId: string) => ({ headers: { space: spaceId } }),
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) => useEffect(effect, [effect]),
  useLocalSearchParams: () => ({ spaceId: state.spaceId, tool: state.tool }),
  useRouter: () => ({ setParams: state.setParams }),
  useNavigation: () => ({
    setOptions: (options: {
      unstable_headerRightItems?: () => typeof state.headerItems;
      unstable_headerLeftItems?: () => typeof state.leftItems;
      headerSearchBarOptions?: typeof state.search;
    }) => {
      if ("unstable_headerRightItems" in options)
        state.headerItems = options.unstable_headerRightItems?.() ?? [];
      if ("unstable_headerLeftItems" in options)
        state.leftItems = options.unstable_headerLeftItems?.() ?? [];
      if ("headerSearchBarOptions" in options) state.search = options.headerSearchBarOptions;
    },
  }),
}));
vi.mock("./native-controls", () => ({ iosAtLeast: () => true }));
vi.mock("../components/name-dialog", () => ({ TextFieldDialog: () => null }));
vi.mock("react-native", () => ({
  Alert: {},
  Platform: { OS: "ios" },
  ScrollView: element("div"),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: element("p"),
  View: element("div"),
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: element("div") }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    actions,
    onPressAction,
    title,
    children,
  }: {
    actions: { id: string; title: string; state?: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    title: string;
    children: ReactNode;
  }) =>
    createElement(
      "div",
      { "aria-label": title },
      children,
      actions.map((action) =>
        createElement(
          "button",
          {
            key: action.id,
            type: "button",
            "aria-pressed": action.state === "on",
            onClick: () => onPressAction({ nativeEvent: { event: action.id } }),
          },
          action.title,
        ),
      ),
    ),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("../components/native-segmented-control", () => ({
  NativeSegmentedControl: ({
    options,
    value,
    onChange,
  }: {
    options: { value: string; label: string }[];
    value?: string;
    onChange: (value: string) => void;
  }) =>
    createElement(
      "div",
      { role: "radiogroup" },
      options.map((option) =>
        createElement(
          "button",
          {
            key: option.value,
            type: "button",
            role: "radio",
            "aria-checked": option.value === value,
            onClick: () => onChange(option.value),
          },
          option.label,
        ),
      ),
    ),
}));
vi.mock("../components/settings-group", () => ({
  SettingsFooter: element("small"),
  SettingsGroup: element("section"),
  SettingsRow: ({
    title,
    value,
    detail,
    onPress,
  }: {
    title: string;
    value?: string;
    detail?: string;
    onPress?: () => void;
  }) =>
    onPress
      ? createElement("button", { type: "button", onClick: onPress }, title)
      : createElement("span", null, `${title}: ${value}${detail ? ` (${detail})` : ""}`),
  SettingsInputRow: ({
    accessibilityLabel,
    value,
    onChangeText,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
  }) =>
    createElement("input", {
      "aria-label": accessibilityLabel,
      value,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
}));

vi.mock("../components/row-accessories", () => ({ Checkmark: () => null }));
vi.mock("../components/list-search-input", () => ({ ListSearchInput: () => null }));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({
    label,
    value,
    choices,
    onChange,
  }: {
    label: string;
    value: string;
    choices: { key: string; label: string }[];
    onChange: (key: string) => void;
  }) =>
    createElement(
      "select",
      {
        "aria-label": label,
        value,
        onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      },
      choices.map((choice) =>
        createElement("option", { key: choice.key, value: choice.key }, choice.label),
      ),
    ),
}));

let root: Root;
let container: HTMLDivElement;
const rows = () => [...container.querySelectorAll("span")].map((node) => node.textContent);
const menu = (title: string) => container.querySelector(`[aria-label="${title}"]`)!;
const menuButton = (title: string, action: string) =>
  [...menu(title).querySelectorAll("button")].find((node) => node.textContent === action);
const rule = (overrides: Partial<Rule> & Pick<Rule, "id">): Rule => ({
  effect: "always_allow",
  matchKind: "tool",
  matchValue: "send_email",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

async function render() {
  await act(async () => root.render(createElement(Approvals)));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.spaceId = undefined;
  state.settings = { mode: "ask", enabled: false, skipApprovals: false, checkerAvailable: false };
  state.rules = [];
  state.headerItems = [];
  state.tool = undefined;
  state.setParams.mockReset();
  state.search = undefined;
  state.leftItems = [];
  state.rpc
    .mockReset()
    .mockImplementation(async (proc: string, input?: Record<string, unknown>) => {
      if (proc === "autoReview/get") return state.settings;
      if (proc === "autoReview/set") {
        state.settings = { ...state.settings, mode: input!.mode as string };
        return state.settings;
      }
      if (proc === "approvalRules/list") return state.rules;
      if (proc === "approvalRules/set")
        return rule({
          id: "saved",
          effect: input!.effect as Rule["effect"],
          matchKind: input!.matchKind as Rule["matchKind"],
          matchValue: input!.matchValue as string,
        });
      if (proc === "approvalRules/remove") return { ok: true };
      throw new Error(`Unexpected RPC: ${proc}`);
    });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

it("lists only the rules; the mode is a row in settings", async () => {
  state.rules = [rule({ id: "tool", matchValue: "send_email" })];
  await render();
  expect(rows()).toEqual(["Send email: Allow"]);
  expect(container.querySelector('[role="radiogroup"]')).toBeNull();
  expect(container.querySelector("small")).toBeNull();
  expect(state.rpc.mock.calls.map(([proc]) => proc)).toEqual([
    "approvalRules/list",
    "autoReview/get",
  ]);
});

it("switches and removes rules, keeping legacy category rules removable only", async () => {
  state.rules = [
    rule({ id: "tool", matchValue: "send_email" }),
    rule({ id: "site", effect: "require_approval", matchKind: "site", matchValue: "example.com" }),
    rule({
      id: "category",
      effect: "require_approval",
      matchKind: "category",
      matchValue: "email",
    }),
  ];
  await render();
  expect(rows()).toEqual(["Send email: Allow", "example.com: Ask", "email: Ask"]);
  expect(menuButton("Send email", "Allow")?.getAttribute("aria-pressed")).toBe("true");
  expect(menuButton("email", "Allow")).toBeUndefined();

  await act(async () => menuButton("example.com", "Block")!.click());
  expect(state.rpc).toHaveBeenCalledWith("approvalRules/set", {
    scope: "account",
    effect: "deny",
    matchKind: "site",
    matchValue: "example.com",
  });
  expect(rows()).toEqual(["Send email: Allow", "example.com: Block", "email: Ask"]);

  await act(async () => menuButton("Send email", "Remove")!.click());
  expect(state.rpc).toHaveBeenCalledWith("approvalRules/remove", { scope: "account", id: "tool" });
  expect(rows()).toEqual(["example.com: Block", "email: Ask"]);
});

it("edits a Space's own copy when opened with one", async () => {
  state.spaceId = "space-1";
  await render();
  const spaceContext = { requestContext: { headers: { space: "space-1" } } };
  expect(state.rpc.mock.calls).toEqual([
    ["approvalRules/list", { scope: "space" }, spaceContext],
    ["autoReview/get", { scope: "space" }, spaceContext],
  ]);
});

function retry() {
  return [...container.querySelectorAll("button")].find((node) => node.textContent === "Retry");
}

it("offers a retry when the first load fails, then shows the rules", async () => {
  state.rules = [rule({ id: "tool", matchValue: "send_email" })];
  state.rpc.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  await render();
  expect(container.textContent).toContain("Something went wrong. Try again.");
  expect(rows()).toEqual([]);

  await act(async () => retry()!.click());
  expect(rows()).toEqual(["Send email: Allow"]);
  expect(retry()).toBeUndefined();
  expect(container.textContent).not.toContain("Something went wrong. Try again.");
});

it("switches a tool rule back to Ask", async () => {
  state.rules = [
    {
      id: "tool",
      effect: "always_allow",
      matchKind: "tool",
      matchValue: "write_file",
      createdAt: "2026-10-25T00:00:00.000Z",
    },
  ];
  await render();
  await act(async () => menuButton("Write file", "Ask")!.click());
  expect(state.rpc).toHaveBeenCalledWith("approvalRules/set", {
    scope: "account",
    effect: "require_approval",
    matchKind: "tool",
    matchValue: "write_file",
  });
  expect(menuButton("Write file", "Ask")!.getAttribute("aria-pressed")).toBe("true");
});

it("selects a stable tool from the catalog and saves from the native header", async () => {
  await render();
  await header("Add rule");
  await click("Write file");
  expect(effects()).toEqual(["Allow", "Ask", "Block"]);
  await header("Save");
  expect(state.rpc).toHaveBeenCalledWith("approvalRules/set", {
    scope: "account",
    effect: "require_approval",
    matchKind: "tool",
    matchValue: "write_file",
  });
  expect(rows()).toEqual(["Write file: Ask"]);
});

async function header(label: string) {
  await act(async () => state.headerItems.find((item) => item.label === label)!.onPress());
}
async function click(label: string) {
  await act(async () =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === label)!.click(),
  );
}
const effects = () => [...container.querySelectorAll("option")].map((node) => node.textContent);

it("uses native search, displays an empty result and clears it", async () => {
  await render();
  await header("Add rule");
  await act(async () =>
    state.search!.onChangeText({ nativeEvent: { text: "nonexistent-tool-example" } }),
  );
  expect(container.textContent).toContain("No tools found.");
  expect(container.textContent).not.toContain("Write file");
  await act(async () => state.search!.onCancelButtonPress());
  expect(container.textContent).toContain("Write file");
  expect(container.textContent).not.toContain("No tools found.");
});

it("does not offer ineffective automatic, mandatory or host choices", async () => {
  state.rules = [rule({ id: "old", matchValue: "read_file", effect: "require_approval" })];
  await render();
  expect(rows()).toEqual(["Read file: Ask (Inactive)"]);
  expect(menuButton("Read file", "Ask")).toBeUndefined();
  await header("Add rule");
  await click("Read file");
  expect(effects()).toEqual(["Allow", "Block"]);
  await click("Create space");
  expect(effects()).toEqual(["Ask", "Block"]);
  await click("User computer shell");
  expect(effects()).toEqual(["Block"]);
  expect(container.textContent).toContain("Computer access is approved separately.");
});

it("opens a known tool deep link and returns to the list after saving", async () => {
  state.tool = "write_file";
  await render();
  expect(effects()).toEqual(["Allow", "Ask", "Block"]);
  await header("Save");
  expect(rows()).toEqual(["Write file: Ask"]);
  expect(state.setParams).toHaveBeenCalledWith({ tool: undefined });
});

it("ignores unknown deep links, and removes Ask in Never ask", async () => {
  state.tool = "write_fiel";
  state.settings = { ...state.settings, mode: "never", skipApprovals: true };
  await render();
  expect(state.headerItems.map((item) => item.label)).toEqual(["Add rule"]);
  await header("Add rule");
  await click("Write file");
  expect(effects()).toEqual(["Allow", "Block"]);
  expect(container.textContent).toContain("Ask rules are inactive in Never ask.");
});

it("does not close a new tool editor when an older save returns", async () => {
  state.tool = "write_file";
  await render();
  let resolveSave!: (value: Rule) => void;
  state.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
  );
  await header("Save");
  state.tool = "shell";
  await render();
  await act(async () => resolveSave(rule({ id: "old", matchValue: "write_file" })));
  expect(container.querySelector("select")).not.toBeNull();
  expect(state.setParams).not.toHaveBeenCalled();
});

it("resets scope and ignores a saved response from the previous Space", async () => {
  state.spaceId = "space-old";
  state.tool = "write_file";
  await render();
  let resolveSave!: (value: Rule) => void;
  state.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
  );
  await header("Save");
  state.spaceId = "space-new";
  state.tool = "shell";
  await render();
  await act(async () => resolveSave(rule({ id: "old", matchValue: "write_file" })));
  expect(rows()).toEqual([]);
  expect(container.querySelector("select")).not.toBeNull();
  expect(state.setParams).not.toHaveBeenCalled();
  expect(state.rpc).toHaveBeenCalledWith(
    "approvalRules/list",
    { scope: "space" },
    { requestContext: { headers: { space: "space-new" } } },
  );
});

it("ignores a stale rules read after switching Space", async () => {
  state.spaceId = "space-old";
  let resolveRead!: (value: Rule[]) => void;
  state.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );
  await render();
  state.spaceId = "space-new";
  state.rules = [rule({ id: "new", matchValue: "write_file", effect: "deny" })];
  await render();
  expect(rows()).toEqual(["Write file: Block"]);
  await act(async () => resolveRead([rule({ id: "old", matchValue: "send_email" })]));
  expect(rows()).toEqual(["Write file: Block"]);
});
