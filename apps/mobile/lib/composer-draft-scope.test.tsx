// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComposerDraftScope } from "./composer-draft";
import { useComposerDraftScope } from "./composer-draft-scope";
import type { SessionChangeReason } from "./session";

const state = vi.hoisted(() => ({
  api: "https://api.example.test",
  generation: 1,
  ready: 1,
  namespace: undefined as string | undefined,
  token: vi.fn(),
  hydrate: vi.fn(),
  clearText: vi.fn(),
  clearFiles: vi.fn(),
  listeners: new Set<() => void>(),
  retire: undefined as undefined | ((sameAccount: boolean, reason: SessionChangeReason) => void),
}));
vi.mock("./api", () => ({
  currentApiBase: () => state.api,
  subscribeApiBase: () => () => undefined,
}));
vi.mock("./artifact-cache-session", () => ({ artifactCacheSession: state.hydrate }));
vi.mock("./composer-draft", () => ({
  clearComposerDrafts: state.clearText,
  composerDraftScope: (userId: string, botId: string) =>
    state.namespace
      ? { apiBase: state.api, userId, threadKey: `bot:${botId}`, namespace: state.namespace }
      : undefined,
  isComposerDraftScopeCurrent: (scope: ComposerDraftScope) =>
    scope.apiBase === state.api && scope.namespace === state.namespace,
}));
vi.mock("./composer-draft-attachments", () => ({
  clearComposerDraftAttachments: state.clearFiles,
}));
vi.mock("./session", () => ({
  currentReadySessionGeneration: () => state.ready,
  currentSessionGeneration: () => state.generation,
  loadSessionToken: state.token,
  registerSessionDiskCache: (callback: typeof state.retire) => {
    state.retire = callback;
  },
  subscribeSessionGeneration: (callback: () => void) => {
    state.listeners.add(callback);
    return () => {
      state.listeners.delete(callback);
    };
  },
}));

let root: Root;
let scope: ComposerDraftScope | undefined;
function Probe({
  userId,
  verifiedGeneration = state.generation,
}: {
  userId: string;
  verifiedGeneration?: number;
}) {
  scope = useComposerDraftScope(userId, "bot-a", undefined, verifiedGeneration);
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.api = "https://api.example.test";
  state.generation = 1;
  state.ready = 1;
  state.namespace = undefined;
  state.token.mockReset().mockResolvedValue("current-token");
  state.hydrate.mockReset().mockImplementation(async () => {
    state.namespace = "login-a";
    return "login-a";
  });
  state.clearText.mockClear();
  state.clearFiles.mockClear();
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("does not access drafts until the login namespace has hydrated", async () => {
  let finish!: (token: string) => void;
  state.token.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  act(() => root.render(<Probe userId="user-a" />));
  expect(scope).toBeUndefined();
  await act(async () => finish("current-token"));
  expect(scope).toMatchObject({ userId: "user-a", namespace: "login-a" });
});

it("does not hydrate stale credentials or claim the new account from a late source read", async () => {
  let finish!: (token: string) => void;
  state.token.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  act(() => root.render(<Probe userId="user-a" />));
  state.generation = 2;
  state.ready = 2;
  await act(async () => root.render(<Probe userId="user-b" />));
  expect(scope?.userId).toBe("user-b");
  await act(async () => finish("old-token"));
  expect(state.hydrate).not.toHaveBeenCalledWith("old-token");
  expect(scope?.userId).toBe("user-b");
});

it("hides the source while authentication is changing and keeps verified rotation's namespace", async () => {
  await act(async () => root.render(<Probe userId="user-a" />));
  state.generation = 2;
  act(() => {
    for (const notify of state.listeners) notify();
  });
  expect(scope).toBeUndefined();
  state.ready = 2;
  await act(async () => {
    for (const notify of state.listeners) notify();
    root.render(<Probe userId="user-a" verifiedGeneration={2} />);
  });
  expect(scope).toMatchObject({ userId: "user-a", namespace: "login-a" });
});

it("keeps rejected-session text recovery distinct from explicit logout and verified rotation", () => {
  state.retire!(false, "session_rejected");
  expect(state.clearText).not.toHaveBeenCalled();
  expect(state.clearFiles).not.toHaveBeenCalled();
  state.retire!(true, "reauthentication");
  expect(state.clearText).not.toHaveBeenCalled();
  expect(state.clearFiles).not.toHaveBeenCalled();
  state.retire!(false, "logout");
  expect(state.clearText).toHaveBeenCalledOnce();
  expect(state.clearFiles).toHaveBeenCalledOnce();
});

it("cannot adopt a new ready login namespace while the verified route still owns the hidden old user", async () => {
  await act(async () => root.render(<Probe userId="user-a" verifiedGeneration={1} />));
  expect(scope?.userId).toBe("user-a");
  state.generation = 2;
  state.ready = 2;
  state.namespace = "login-b";
  state.hydrate.mockImplementation(async () => "login-b");
  state.hydrate.mockClear();
  await act(async () => {
    for (const notify of state.listeners) notify();
    root.render(<Probe userId="user-a" verifiedGeneration={1} />);
  });
  expect(scope).toBeUndefined();
  expect(state.hydrate).not.toHaveBeenCalled();
  await act(async () => root.render(<Probe userId="user-b" verifiedGeneration={2} />));
  expect(scope).toMatchObject({ userId: "user-b", namespace: "login-b" });
});
