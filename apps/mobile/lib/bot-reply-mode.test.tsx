// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

// @vitest-environment jsdom
import type { BotReplyMode } from "@orkbot/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotReplyModeSetting } from "../components/bot-reply-mode";

const state = vi.hoisted(() => ({
  update: vi.fn(),
  load: vi.fn(),
  generation: 0,
  ready: 0,
  apiBase: "https://example.test",
  selection: 0,
  listeners: new Set<() => void>(),
  caches: new Set<(same: boolean) => void>(),
}));
vi.mock("../lib/settings-target", () => ({
  captureSettingsContext: () => {
    const owner = state.generation;
    return {
      isCurrent: () => owner === state.generation,
      send: (procedure: string, args: unknown) =>
        procedure === "bots/get" ? state.load(args) : state.update(args),
    };
  },
}));
vi.mock("../lib/api", () => ({
  currentApiBase: () => state.apiBase,
  selectedSpaceId: () => "space",
  spaceSelectionSeq: () => state.selection,
}));
vi.mock("../lib/session", () => ({
  currentSessionGeneration: () => state.generation,
  currentReadySessionGeneration: () => state.ready,
  subscribeSessionGeneration: (listener: () => void) => {
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  },
  registerSessionDiskCache: (listener: (same: boolean) => void) => {
    state.caches.add(listener);
    return () => {
      state.caches.delete(listener);
    };
  },
}));
vi.mock("../lib/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("../lib/native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("../lib/user-error", () => ({ errorText: (error: Error) => error.message }));
vi.mock("react-native", () => ({
  View: "div",
  Text: "span",
  Pressable: "button",
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <div data-selected={value}>
      <button type="button" onClick={() => onChange("chat")}>
        Chat
      </button>
      <button type="button" onClick={() => onChange("explicit")}>
        Updates and final reply
      </button>
    </div>
  ),
}));
function deferred() {
  let resolve!: (value: { replyMode?: BotReplyMode }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ replyMode?: BotReplyMode }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const bot = { id: "bot", spaceId: "space", replyMode: "chat" as const, updatedAt: "2026-01-01" };
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.generation = state.ready = state.selection = 0;
  state.apiBase = "https://example.test";
  state.update.mockReset();
  state.load.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<BotReplyModeSetting bot={bot} />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function choose(value: BotReplyMode) {
  await act(async () => {
    container.querySelectorAll<HTMLButtonElement>("button")[value === "chat" ? 0 : 1]!.click();
  });
}
function shown() {
  return container.querySelector("[data-selected]")!.getAttribute("data-selected");
}

describe("scoped reply mode saves", () => {
  it("releases the parent Save boundary when a renewed old server does not support reply modes", async () => {
    let flush: (() => Promise<void>) | undefined;
    const registerFlush = (next: typeof flush) => {
      flush = next;
    };
    const pending = vi.fn();
    await act(async () =>
      root.render(
        <BotReplyModeSetting bot={bot} registerFlush={registerFlush} onSavingChange={pending} />,
      ),
    );
    const first = deferred();
    state.update.mockReturnValueOnce(first.promise);
    state.load.mockResolvedValueOnce({ ...bot, replyMode: undefined });
    await choose("explicit");
    await act(async () => {
      state.generation += 1;
      for (const listener of state.caches) listener(true);
      state.ready = state.generation;
      for (const listener of state.listeners) listener();
    });
    await act(async () => first.reject(new Error("retired save")));
    expect(container.querySelector("[data-selected]")).toBeNull();
    expect(flush).toBeUndefined();
    expect(pending).toHaveBeenLastCalledWith(false);
    // The real parent uses this optional boundary before navigation/other settings saves.
    await expect(Promise.all([flush?.()])).resolves.toEqual([undefined]);
  });
  it("renews only after verified same-account rotation and a fresh bot read, retiring the old ACK", async () => {
    const first = deferred();
    state.update
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ replyMode: "chat", updatedAt: "2026-01-05" });
    state.load.mockResolvedValueOnce({ ...bot, replyMode: "explicit", updatedAt: "2026-01-04" });
    await choose("explicit");
    await choose("chat");
    await act(async () => {
      state.generation += 1;
      for (const listener of state.caches) listener(true);
      state.ready = state.generation;
      for (const listener of state.listeners) listener();
    });
    expect(state.load).not.toHaveBeenCalled();
    await act(async () => first.resolve({ replyMode: "explicit" }));
    expect(state.load).toHaveBeenCalledWith({ botId: "bot" });
    expect(shown()).toBe("explicit");
    await choose("chat");
    expect(state.update).toHaveBeenCalledTimes(2);
    expect(shown()).toBe("chat");
  });
  it("never adopts an old target after logout followed by a later verified rotation", async () => {
    await act(async () => {
      state.generation += 1;
      for (const listener of state.caches) listener(false);
      state.ready = state.generation;
      for (const listener of state.listeners) listener();
    });
    await act(async () => {
      state.generation += 1;
      for (const listener of state.caches) listener(true);
      state.ready = state.generation;
      for (const listener of state.listeners) listener();
    });
    await choose("explicit");
    expect(state.load).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
    expect(shown()).toBe("chat");
  });
  it("retains its confirmed state over a stale roster and accepts a genuinely newer server value", async () => {
    state.update.mockResolvedValueOnce({ replyMode: "explicit", updatedAt: "2026-01-03" });
    await choose("explicit");
    await act(async () =>
      root.render(<BotReplyModeSetting bot={{ ...bot, updatedAt: "2026-01-02" }} />),
    );
    expect(shown()).toBe("explicit");
    await act(async () =>
      root.render(<BotReplyModeSetting bot={{ ...bot, updatedAt: "2026-01-04" }} />),
    );
    expect(shown()).toBe("chat");
  });
  it("sends the same minimal payload and confirms the selected mode", async () => {
    state.update.mockResolvedValueOnce({ replyMode: "explicit" });
    await choose("explicit");
    expect(state.update).toHaveBeenCalledWith({ botId: "bot", replyMode: "explicit" });
    expect(shown()).toBe("explicit");
  });
  it("keeps a newer edit while the older acknowledgement and next save are pending", async () => {
    const first = deferred();
    const next = deferred();
    state.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
    await choose("explicit");
    await choose("chat");
    await act(async () => first.resolve({ replyMode: "explicit" }));
    expect(state.update).toHaveBeenCalledTimes(2);
    expect(shown()).toBe("chat");
    await act(async () => next.resolve({ replyMode: "chat" }));
    expect(shown()).toBe("chat");
  });
  it("rolls back only the failed latest choice", async () => {
    state.update.mockRejectedValueOnce(new Error("offline"));
    await choose("explicit");
    expect(shown()).toBe("chat");
    expect(container.textContent).toContain("offline");
  });
  it.each(["resolve", "reject"] as const)(
    "retires an old owner before a late %s and never sends its queued choice",
    async (ending) => {
      const first = deferred();
      state.update.mockReturnValueOnce(first.promise);
      await choose("explicit");
      await choose("chat");
      state.generation += 1;
      await act(async () => {
        if (ending === "resolve") first.resolve({ replyMode: "explicit" });
        else first.reject(new Error("old-owner-error"));
      });
      expect(state.update).toHaveBeenCalledTimes(1);
      expect(container.textContent).not.toContain("old-owner-error");
      expect(shown()).toBe("chat");
    },
  );
  it("does not acknowledge an unsupported server response", async () => {
    state.update.mockResolvedValueOnce({});
    await choose("explicit");
    expect(shown()).toBe("chat");
    expect(container.textContent).toContain("Could not save bot");
  });
});
