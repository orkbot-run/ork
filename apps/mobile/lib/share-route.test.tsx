// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache share route tests are preserved; scoped selection regressions follow LICENSE.md.

// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pending: { text: "https://example.com", files: [], arrivedAt: 0, generation: 1 } as unknown,
  cancel: vi.fn(),
  select: vi.fn(),
  rpc: vi.fn(),
  server: "https://server.example.test",
  session: 1,
  ready: 1,
  account: 1,
  space: "space-a",
  spaceVersion: 1,
  binding: 1,
  namespace: "login-a",
  scopeAvailable: true,
  onShareSelect: undefined as
    | undefined
    | ((bot: { id: string; name: string; spaceId: string }) => void),
  dismissTo: vi.fn(),
  reset: vi.fn(),
  beforeRemove: undefined as
    | undefined
    | ((event: {
        preventDefault: () => void;
        data: { action: { payload?: { name: string } } };
      }) => void),
}));
const router = { dismissTo: state.dismissTo };
const navigation = {
  dispatch: state.reset,
  addListener: (_name: string, listener: typeof state.beforeRemove) => {
    state.beforeRemove = listener;
    return () => {
      state.beforeRemove = undefined;
    };
  },
};
vi.mock("expo-router", () => ({ useRouter: () => router, useNavigation: () => navigation }));
vi.mock("./incoming-share", () => ({
  getIncomingShare: () => state.pending,
  subscribeIncomingShare: () => () => {},
  cancelIncomingShare: state.cancel,
  selectIncomingShare: state.select,
}));
vi.mock("./accounts", () => ({
  accountsVersion: () => state.account,
  subscribeAccounts: () => () => undefined,
}));
vi.mock("./api", () => ({
  currentApiBase: () => state.server,
  subscribeApiBase: () => () => undefined,
  currentSessionGeneration: () => state.session,
  selectedSpaceId: () => state.space,
  spaceSelectionSeq: () => state.spaceVersion,
  captureApiRequestContext: async () => ({
    apiBase: state.server,
    sessionGeneration: state.session,
    headers: {},
  }),
  loadSessionToken: async () => "fixture-scope",
  rpc: state.rpc,
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => state.session,
  currentReadySessionGeneration: () => state.ready,
  subscribeSessionGeneration: () => () => undefined,
}));
vi.mock("./installation-transport", () => ({
  installationRevocationScope: () => ({
    account: state.account,
    target: { bindingVersion: state.binding },
  }),
}));
vi.mock("./artifact-cache-session", () => ({ artifactCacheSession: async () => state.namespace }));
vi.mock("./workspace-draft-session", () => ({
  hydrateWorkspaceDraftSession: async () => undefined,
}));
vi.mock("./composer-draft", () => ({
  composerDraftScope: (userId: string, botId: string) =>
    state.scopeAvailable
      ? {
          apiBase: state.server,
          userId,
          threadKey: `bot:${botId}`,
          namespace: state.namespace,
          workspaceOwner: `binding-${state.binding}`,
        }
      : undefined,
  composerDraftScopeKey: (scope: unknown) => JSON.stringify(scope),
  isComposerDraftScopeCurrent: () => state.scopeAvailable,
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  Image: () => null,
}));
vi.mock("../components/glass-icon-button", () => ({
  GlassIconButton: ({ onPress }: { onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, "Close"),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../app/index", () => ({
  HomeSession: ({
    onShareSelect,
  }: {
    onShareSelect: (bot: { id: string; name: string; spaceId: string }) => void;
  }) => {
    state.onShareSelect = onShareSelect;
    return createElement(
      "button",
      {
        type: "button",
        onClick: () => onShareSelect({ id: "example", name: "Bot", spaceId: "space-a" }),
      },
      "Chat",
    );
  },
}));

import ShareRoute from "../app/share";

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
async function render() {
  root = createRoot(container);
  await act(async () => root.render(createElement(ShareRoute)));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(state, {
    server: "https://server.example.test",
    session: 1,
    ready: 1,
    account: 1,
    space: "space-a",
    spaceVersion: 1,
    binding: 1,
    namespace: "login-a",
    scopeAvailable: true,
  });
  state.rpc.mockResolvedValue({ userId: "user-a", spaceId: "space-a" });
  state.select.mockReturnValue(true);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  state.pending = { text: "https://example.com", files: [], arrivedAt: 0, generation: 1 };
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
describe("share route", () => {
  it("returns safely to the inbox when the share is absent or expired", async () => {
    state.pending = null;
    await render();
    expect(state.dismissTo).toHaveBeenCalledWith("/");
  });
  it("clears the pending share on close and returns to the inbox", async () => {
    await render();
    await act(async () => container.querySelector("button")?.click());
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(state.dismissTo).toHaveBeenCalledWith("/");
  });
  it("preserves the pending share while redirecting to sign-in", async () => {
    await render();
    const preventDefault = vi.fn();
    state.beforeRemove?.({ preventDefault, data: { action: { payload: { name: "sign-in" } } } });
    expect(state.cancel).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(state.dismissTo).not.toHaveBeenCalled();
  });
  it("cancels on native back or dismissal", async () => {
    await render();
    const preventDefault = vi.fn();
    await act(async () => state.beforeRemove?.({ preventDefault, data: { action: {} } }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(state.dismissTo).toHaveBeenCalledWith("/");
  });
  it("preserves the share for the selected thread and removes the target screen", async () => {
    await render();
    await act(async () => container.querySelectorAll("button")[1]?.click());
    state.beforeRemove?.({ preventDefault: vi.fn(), data: { action: {} } });
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.dismissTo).not.toHaveBeenCalled();
    expect(state.rpc).toHaveBeenCalledWith("me", undefined, {
      requestContext: { apiBase: "https://server.example.test", sessionGeneration: 1, headers: {} },
      skipSpaceAuthRecovery: true,
    });
    expect(state.select).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        apiBase: "https://server.example.test",
        userId: "user-a",
        threadKey: "bot:example",
        namespace: "login-a",
        workspaceOwner: "binding-1",
      }),
      1,
    );
    expect(state.reset).toHaveBeenCalledWith({
      type: "RESET",
      payload: {
        index: 1,
        routes: [{ name: "index" }, { name: "thread", params: { botId: "example", name: "Bot" } }],
      },
    });
  });
});

function delayedMe() {
  let resolve!: (value: { userId: string; spaceId: string }) => void;
  const promise = new Promise<{ userId: string; spaceId: string }>((done) => {
    resolve = done;
  });
  state.rpc.mockReturnValue(promise);
  return () => resolve({ userId: "user-a", spaceId: "space-a" });
}

it.each(["account", "session", "server", "space", "spaceVersion", "binding", "newShare"])(
  "ignores a late recipient lookup after %s changed",
  async (changed) => {
    const finish = delayedMe();
    await render();
    await act(async () => container.querySelectorAll("button")[1]?.click());
    if (changed === "account") state.account++;
    if (changed === "session") state.session++;
    if (changed === "server") state.server = "https://other.example.test";
    if (changed === "space") state.space = "space-b";
    if (changed === "spaceVersion") state.spaceVersion++;
    if (changed === "binding") state.binding++;
    if (changed === "newShare")
      state.pending = { text: "new share", files: [], arrivedAt: 0, generation: 2 };
    await act(async () => finish());
    expect(state.select).not.toHaveBeenCalled();
    expect(state.reset).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
  },
);

it("does not select or navigate after the picker is unmounted during a lookup", async () => {
  const finish = delayedMe();
  await render();
  await act(async () => container.querySelectorAll("button")[1]?.click());
  await act(async () => root.unmount());
  await act(async () => finish());
  expect(state.select).not.toHaveBeenCalled();
  expect(state.reset).not.toHaveBeenCalled();
});

it.each(["denied", "wrongSpace", "unavailableScope"])(
  "keeps the payload unassigned when the selected destination is %s",
  async (failure) => {
    if (failure === "denied") state.rpc.mockRejectedValue(new Error("Access denied"));
    if (failure === "wrongSpace")
      state.rpc.mockResolvedValue({ userId: "user-a", spaceId: "space-b" });
    if (failure === "unavailableScope") state.scopeAvailable = false;
    await render();
    await act(async () => container.querySelectorAll("button")[1]?.click());
    expect(state.select).not.toHaveBeenCalled();
    expect(state.reset).not.toHaveBeenCalled();
    expect(state.pending).not.toBeNull();
    expect(container.textContent).toContain("Something went wrong. Try again.");
  },
);

it.each(["account", "server", "binding", "newShare"])(
  "refuses an old rendered onPress after %s changed, before starting any lookup",
  async (changed) => {
    await render();
    const oldPress = state.onShareSelect!;
    if (changed === "account") state.account++;
    if (changed === "server") state.server = "https://other.example.test";
    if (changed === "binding") state.binding++;
    if (changed === "newShare")
      state.pending = { text: "new share", files: [], arrivedAt: 0, generation: 2 };
    await act(async () => oldPress({ id: "example", name: "Bot", spaceId: "space-a" }));
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.select).not.toHaveBeenCalled();
    expect(state.reset).not.toHaveBeenCalled();
  },
);

it("does not adopt the current global owner when an old onPress runs after unmount", async () => {
  await render();
  const oldPress = state.onShareSelect!;
  await act(async () => root.unmount());
  await act(async () => oldPress({ id: "example", name: "Bot", spaceId: "space-a" }));
  expect(state.rpc).not.toHaveBeenCalled();
  expect(state.select).not.toHaveBeenCalled();
  expect(state.reset).not.toHaveBeenCalled();
});
