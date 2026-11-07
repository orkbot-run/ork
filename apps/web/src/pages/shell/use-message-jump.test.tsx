// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Bot, ThreadMessage } from "@orkbot/contracts";
import { foldPeerReplies } from "@orkbot/core";
import { fetchFresh } from "@orkbot/core/query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageJump } from "./use-message-jump";

vi.mock("../../lib/query", () => ({ queryClient: {} }));
vi.mock("@orkbot/core/query", () => ({ fetchFresh: vi.fn(async () => []) }));

type Props = Parameters<typeof useMessageJump>[0];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const snapshot = (botId: string, groupId?: string) => ({
  threadId: groupId ? `thread-${groupId}` : `thread-${botId}`,
  botId: groupId ? undefined : botId,
  groupId,
  messages: [],
  olderCursor: null,
});
function page(botId: string, messageId = "message-a", groupId?: string) {
  return {
    ...snapshot(botId, groupId),
    messages: [
      {
        id: messageId,
        threadId: `thread-${botId}`,
        seq: 1,
        role: "user",
        blocks: [{ kind: "text", text: "Fixture" }],
      } as ThreadMessage,
    ],
  };
}

let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(fetchFresh).mockReset().mockResolvedValue([]);
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture(groupId?: string) {
  const around = deferred<ReturnType<typeof page>>();
  const head = deferred<ReturnType<typeof snapshot>>();
  const get = vi.fn(() => head.promise);
  const messages = vi.fn(() => around.promise);
  const navigate = vi.fn();
  const commitSnapshot = vi.fn();
  const commitComputer = vi.fn();
  const setRoutines = vi.fn();
  const props = {
    rpc: { threads: { get, messages } },
    queries: { routines: { list: { queryOptions: vi.fn(() => ({})) } } },
    thread: {
      snapshot: null,
      commitSnapshot,
      routines: [],
      setRoutines,
      routinesBotId: null,
      setRoutinesBotId: vi.fn(),
      expandedHistoryThread: { current: null },
      historyEpoch: { current: 0 },
      messageScroll: { current: null },
      pinnedAroundRef: { current: null },
    },
    commitComputer,
    transcript: foldPeerReplies([]),
    active: { id: "bot-a" } as Bot,
    inGroup: Boolean(groupId),
    groupId,
    activeBotId: { current: "bot-a" },
    activeGroupId: { current: groupId },
    searchParams: new URLSearchParams("m=message-a&panel=notes"),
    setSearchParams: navigate,
    setPanel: vi.fn(),
    setPanelState: vi.fn(),
    editRoutine: vi.fn(),
    resetRoutineTarget: vi.fn(),
  } as unknown as Props;
  let result!: ReturnType<typeof useMessageJump>;
  function Harness() {
    result = useMessageJump(props);
    return null;
  }
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  act(() => root.render(<Harness />));
  let mounted = true;
  const unmount = () => {
    if (mounted) act(() => root.unmount());
    mounted = false;
    element.remove();
  };
  cleanup = unmount;
  const rerender = () => act(() => root.render(<Harness />));
  const finish = async (messageId = "message-a") =>
    act(async () => {
      head.resolve(snapshot("bot-a", groupId));
      around.resolve(page("bot-a", messageId, groupId));
    });
  return {
    props,
    head,
    around,
    get,
    messages,
    navigate,
    commitSnapshot,
    commitComputer,
    setRoutines,
    unmount,
    rerender,
    finish,
    result: () => result,
  };
}

describe("message-jump ownership", () => {
  it.each([undefined, "group-a"])(
    "cleans only the current mounted chat query (%s)",
    async (groupId) => {
      const f = fixture(groupId);
      await f.finish();
      expect(f.commitSnapshot).toHaveBeenCalledOnce();
      expect(f.navigate).toHaveBeenCalledExactlyOnceWith(new URLSearchParams("panel=notes"), {
        replace: true,
      });
    },
  );
  it.each([undefined, "group-a"])(
    "does not navigate or commit after the owner unmounts (%s)",
    async (groupId) => {
      const f = fixture(groupId);
      f.unmount();
      await f.finish();
      expect(f.commitSnapshot).not.toHaveBeenCalled();
      expect(f.commitComputer).not.toHaveBeenCalled();
      expect(f.navigate).not.toHaveBeenCalled();
    },
  );
  it("cannot navigate back or overwrite a different chat after a late result", async () => {
    const f = fixture();
    f.props.active = { id: "bot-b" } as Bot;
    f.props.activeBotId.current = "bot-b";
    f.props.searchParams = new URLSearchParams("panel=computer");
    f.rerender();
    await f.finish();
    expect(f.commitSnapshot).not.toHaveBeenCalled();
    expect(f.navigate).not.toHaveBeenCalled();
  });
  it("invalidates an old request when the bound Space client changes with matching chat IDs", async () => {
    const f = fixture();
    const nextHead = deferred<ReturnType<typeof snapshot>>();
    const nextAround = deferred<ReturnType<typeof page>>();
    f.props.rpc = {
      threads: { get: vi.fn(() => nextHead.promise), messages: vi.fn(() => nextAround.promise) },
    } as unknown as Props["rpc"];
    f.rerender();
    await f.finish();
    expect(f.commitSnapshot).not.toHaveBeenCalled();
    expect(f.navigate).not.toHaveBeenCalled();
    await act(async () => {
      nextHead.resolve(snapshot("bot-a"));
      nextAround.resolve(page("bot-a"));
    });
    expect(f.commitSnapshot).toHaveBeenCalledOnce();
    expect(f.navigate).toHaveBeenCalledOnce();
  });
  it("does not regain ownership after leaving and returning to the same chat", async () => {
    const f = fixture();
    f.props.active = { id: "bot-b" } as Bot;
    f.props.activeBotId.current = "bot-b";
    f.props.searchParams = new URLSearchParams();
    f.rerender();
    f.props.active = { id: "bot-a" } as Bot;
    f.props.activeBotId.current = "bot-a";
    f.rerender();
    await f.finish();
    expect(f.commitSnapshot).not.toHaveBeenCalled();
    expect(f.navigate).not.toHaveBeenCalled();
  });
  it("leaves a newer jump query untouched when the older request finishes first", async () => {
    const f = fixture();
    const nextHead = deferred<ReturnType<typeof snapshot>>();
    const nextAround = deferred<ReturnType<typeof page>>();
    f.get.mockReturnValueOnce(nextHead.promise);
    f.messages.mockReturnValueOnce(nextAround.promise);
    f.props.searchParams = new URLSearchParams("m=message-b&panel=computer");
    f.rerender();
    await f.finish();
    expect(f.commitSnapshot).not.toHaveBeenCalled();
    expect(f.navigate).not.toHaveBeenCalled();
    await act(async () => {
      nextHead.resolve(snapshot("bot-a"));
      nextAround.resolve(page("bot-a", "message-b"));
    });
    expect(f.commitSnapshot).toHaveBeenCalledOnce();
    expect(f.result().scrollRequest?.messageId).toBe("message-b");
    expect(f.navigate).toHaveBeenCalledExactlyOnceWith(new URLSearchParams("panel=computer"), {
      replace: true,
    });
  });
  it("uses the newest setter and preserves parameters added while a jump was pending", async () => {
    const f = fixture();
    const nextNavigate = vi.fn();
    f.props.searchParams = new URLSearchParams("m=message-a&panel=computer&tab=files");
    f.props.setSearchParams = nextNavigate;
    f.rerender();
    await f.finish();
    expect(f.navigate).not.toHaveBeenCalled();
    expect(nextNavigate).toHaveBeenCalledExactlyOnceWith(
      new URLSearchParams("panel=computer&tab=files"),
      { replace: true },
    );
  });
  it("does not clean a query removed by the user", async () => {
    const f = fixture();
    f.props.searchParams = new URLSearchParams("panel=notes");
    f.rerender();
    await f.finish();
    expect(f.commitSnapshot).not.toHaveBeenCalled();
    expect(f.navigate).not.toHaveBeenCalled();
  });
  it("keeps a late routine read from updating an unmounted chat", async () => {
    const routines = deferred<never[]>();
    vi.mocked(fetchFresh).mockReturnValueOnce(routines.promise);
    const f = fixture();
    await f.finish();
    expect(fetchFresh).toHaveBeenCalledOnce();
    f.unmount();
    await act(async () => {
      routines.resolve([]);
    });
    expect(f.setRoutines).not.toHaveBeenCalled();
  });
  it("does not scroll an unmounted chat after a missing-message fallback", async () => {
    let frame!: FrameRequestCallback;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    const f = fixture();
    const scroller = { scrollTop: 0, scrollHeight: 500 } as HTMLDivElement;
    f.props.thread.messageScroll.current = scroller;
    await act(async () => {
      f.head.resolve(snapshot("bot-a"));
      f.around.resolve({ ...page("bot-a"), messages: [] });
    });
    f.unmount();
    frame(0);
    expect(scroller.scrollTop).toBe(0);
  });
  it.each([false, true])(
    "consumes a failed fetch only while its query still belongs to this chat (left: %s)",
    async (left) => {
      const f = fixture();
      if (left) f.unmount();
      await act(async () => {
        f.head.reject(new Error("offline"));
        f.around.resolve(page("bot-a"));
      });
      expect(f.commitSnapshot).not.toHaveBeenCalled();
      expect(f.navigate).toHaveBeenCalledTimes(left ? 0 : 1);
    },
  );
});
