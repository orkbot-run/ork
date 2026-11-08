// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

// @vitest-environment jsdom
import type { BotReplyMode } from "@orkbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotReplyModeSetting } from "./bot-reply-mode";

const state = vi.hoisted(() => ({ update: vi.fn(), generation: 0 }));
vi.mock("../../lib/rpc", () => ({
  captureRpcContext: () => {
    const owner = state.generation;
    return {
      isCurrent: () => owner === state.generation,
      client: { bots: { update: (args: unknown) => state.update(args) } },
    };
  },
}));
vi.mock("../../lib/user-error", () => ({ errorText: (error: Error) => error.message }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@orkbot/ui-web", () => ({
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
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
  state.generation = 0;
  state.update.mockReset();
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
    const select = container.querySelector("select")!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function shown() {
  return container.querySelector("select")!.value;
}

describe("scoped reply mode saves", () => {
  it("finishes an already accepted queued choice after ordinary panel close", async () => {
    const first = deferred();
    state.update.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ replyMode: "chat" });
    await choose("explicit");
    await choose("chat");
    await act(async () => root.render(null));
    await act(async () => first.resolve({ replyMode: "explicit" }));
    expect(state.update).toHaveBeenCalledTimes(2);
    expect(state.update).toHaveBeenLastCalledWith({ botId: "bot", replyMode: "chat" });
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
    expect(container.textContent).toContain("Could not save");
  });
});
