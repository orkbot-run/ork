// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved; notification ownership regressions follow LICENSE.md.

// @vitest-environment jsdom
import type { Bot, ChatAlert, ProductEvent } from "@orkbot/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../lib/i18n";
import type { RpcClient } from "../../lib/rpc";
import { useBrowserNotifications } from "./use-browser-notifications";

const context = vi.hoisted(() => ({
  generation: 0,
  server: "server-1",
  spaceId: "space-1" as string | null,
}));
vi.mock("../../lib/rpc", () => ({
  captureRpcContext: () => {
    const generation = context.generation;
    const server = context.server;
    const spaceId = context.spaceId;
    return {
      isCurrent: () =>
        generation === context.generation &&
        server === context.server &&
        spaceId === context.spaceId,
    };
  },
}));
vi.mock("../../lib/notification-icon", () => ({
  notificationIcon: () => undefined,
  prepareNotificationIcons: () => undefined,
}));

type Frame = { type: "alert" | "heartbeat"; alert?: ChatAlert };

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static shown: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    FakeNotification.shown.push(this);
  }
  close() {
    this.closed = true;
  }
}

let streams: Array<{ push: (frame: Frame) => void; fail: (error: unknown) => void }>;
let signals: AbortSignal[];
let focused: boolean;
let visible: boolean;
let openChat: ReturnType<typeof vi.fn<(alert: ChatAlert) => void>>;
let root: Root;

function stream(): AsyncIterable<Frame> {
  const queue: Frame[] = [];
  let failure: unknown;
  let wake: (() => void) | undefined;
  streams.push({
    push: (frame) => {
      queue.push(frame);
      wake?.();
    },
    fail: (error) => {
      failure = error;
      wake?.();
    },
  });
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (failure) throw failure;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

const rpc = {
  notifications: {
    subscribe: (_input: undefined, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      return Promise.resolve(stream());
    },
  },
} as unknown as Pick<RpcClient, "notifications">;

const fixtureBots = [{ id: "bot-b", name: "Scout", notifyOnFinish: true }] as Bot[];
let callbacks: ReturnType<typeof useBrowserNotifications>;
let currentRpc = rpc;

function Harness({ botId, groupId }: { botId?: string; groupId?: string }) {
  callbacks = useBrowserNotifications(
    fixtureBots,
    { current: fixtureBots },
    {
      rpc: currentRpc,
      activeBotId: { current: botId },
      activeGroupId: { current: groupId },
      openChat,
    },
  );
  return null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function open(chat: { botId?: string; groupId?: string }) {
  act(() => root.render(<Harness {...chat} />));
  await flush();
}

async function send(alert: Partial<ChatAlert>) {
  streams.at(-1)!.push({
    type: "alert",
    alert: {
      kind: "completion",
      title: "Scout finished",
      body: "The report is ready.",
      spaceId: "space-1",
      botId: "bot-b",
      threadId: "thread-b",
      ...alert,
    },
  });
  await flush();
}

const shown = () => FakeNotification.shown.map((n) => [n.title, n.options.body, n.options.tag]);

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", FakeNotification);
  context.generation = 0;
  context.server = "server-1";
  context.spaceId = "space-1";
  currentRpc = rpc;
  FakeNotification.permission = "granted";
  FakeNotification.shown = [];
  streams = [];
  signals = [];
  focused = true;
  visible = true;
  openChat = vi.fn<(alert: ChatAlert) => void>();
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    visible ? "visible" : "hidden",
  );
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useBrowserNotifications chat alerts", () => {
  it("alerts for every kind in another chat while the app is focused", async () => {
    await open({ botId: "bot-a" });
    await send({});
    await send({ kind: "help", title: "Scout needs an answer", body: "Which repo?" });
    await send({ kind: "takeover", title: "Scout needs you on the screen", body: "Log in" });
    await send({ kind: "failure", title: "Scout failed", body: "Timed out" });
    await send({ kind: "completion", body: "Second reply." });
    expect(shown()).toEqual([
      ["Scout finished", "The report is ready.", "thread-b:completion"],
      ["Scout needs an answer", "Which repo?", "thread-b:help"],
      ["Scout needs you on the screen", "Log in", "thread-b:takeover"],
      ["Scout failed", "Timed out", "thread-b:failure"],
      ["Scout finished", "Second reply.", "thread-b:completion"],
    ]);
  });

  it("opens the alerted chat when clicked", async () => {
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    await open({ botId: "bot-a" });
    await send({ groupId: "group-g", threadId: "thread-g" });
    const [notification] = FakeNotification.shown;
    notification!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(openChat).toHaveBeenCalledWith(expect.objectContaining({ groupId: "group-g" }));
    expect(notification!.closed).toBe(true);
  });

  it("leaves the open chat to its own stream", async () => {
    focused = false;
    await open({ botId: "bot-b" });
    await send({ kind: "completion" });
    await send({ kind: "failure" });
    await send({ kind: "help" });
    expect(shown()).toEqual([]);
  });

  it("treats a bot's alert from a group as another chat", async () => {
    await open({ botId: "bot-b" });
    await send({ groupId: "group-g", threadId: "thread-g" });
    expect(shown()).toHaveLength(1);
  });

  it("skips the open group's alerts", async () => {
    focused = false;
    await open({ groupId: "group-g" });
    await send({ groupId: "group-g", threadId: "thread-g" });
    expect(shown()).toEqual([]);
  });

  it("alerts for a takeover in the open chat only when the window is in the background", async () => {
    await open({ botId: "bot-b" });
    await send({ kind: "takeover" });
    expect(shown()).toEqual([]);
    visible = false;
    await send({ kind: "takeover" });
    expect(shown()).toHaveLength(1);
  });

  it("stays silent until notifications are allowed", async () => {
    FakeNotification.permission = "default";
    await open({ botId: "bot-a" });
    await send({});
    expect(shown()).toEqual([]);
  });

  it("reconnects after the stream drops", async () => {
    vi.useFakeTimers();
    await open({ botId: "bot-a" });
    streams[0]!.fail(new Error("network"));
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(streams).toHaveLength(2);
    await send({});
    expect(shown()).toHaveLength(1);
  });

  it("closes the stream when the shell unmounts", async () => {
    await open({ botId: "bot-a" });
    act(() => root.unmount());
    expect(signals[0]!.aborted).toBe(true);
    root = createRoot(document.createElement("div"));
  });
});

const event = (id = "message-1") =>
  ({
    id,
    spaceId: "space-1",
    createdAt: "2026-01-01T00:00:00Z",
    type: "thread.message.created",
    threadId: "thread-b",
    botId: "bot-b",
    seq: 2,
    payload: { role: "bot", blocks: [{ kind: "text", text: "Ready" }] },
  }) as ProductEvent;

function notify(groupId?: string) {
  callbacks.notifyBrowserForEvent(event(), "thread-b", 0, true, "Scout", true, groupId);
}

it.each([undefined, "group-g"])(
  "focuses and opens the captured active chat %s even after selection changes",
  async (groupId) => {
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    focused = false;
    await open({ botId: groupId ? undefined : "bot-b", groupId });
    notify(groupId);
    expect(FakeNotification.shown).toHaveLength(1);
    const notification = FakeNotification.shown[0]!;
    await open({ botId: "bot-a" });
    notification.onclick!();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(openChat).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "bot-b",
        threadId: "thread-b",
        spaceId: "space-1",
        ...(groupId ? { groupId } : {}),
      }),
    );
    expect(notification.closed).toBe(true);
  },
);

it("closes notifications and rejects captured clicks and pending flush after unmount", async () => {
  const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
  focused = false;
  await open({ botId: "bot-b" });
  notify();
  await send({ groupId: "group-g" });
  const clicks = FakeNotification.shown.map((notification) => notification.onclick!);
  FakeNotification.permission = "default";
  callbacks.notifyBrowserForEvent(event("pending"), "thread-b", 0, true, "Scout", true, undefined);
  const old = callbacks;
  act(() => root.unmount());
  root = createRoot(document.createElement("div"));
  expect(FakeNotification.shown.every((notification) => notification.closed)).toBe(true);
  expect(
    FakeNotification.shown.every(
      (notification) => notification.onclick === null && notification.onclose === null,
    ),
  ).toBe(true);
  FakeNotification.permission = "granted";
  for (const click of clicks) click();
  old.flushPendingBrowserNotifications();
  expect(focus).not.toHaveBeenCalled();
  expect(openChat).not.toHaveBeenCalled();
  expect(FakeNotification.shown).toHaveLength(2);
});

it.each(["session", "server", "space", "rpc"] as const)(
  "retires clicks, events and permission-held entries on %s replacement",
  async (reason) => {
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    focused = false;
    await open({ botId: "bot-b" });
    await send({ groupId: "group-g" });
    const click = FakeNotification.shown[0]!.onclick!;
    FakeNotification.permission = "default";
    notify();
    const old = callbacks;
    const oldStream = streams[0]!;
    if (reason === "session") context.generation++;
    else if (reason === "server") context.server = "server-2";
    else if (reason === "space") context.spaceId = "space-2";
    else currentRpc = { notifications: { ...rpc.notifications } };
    if (reason === "rpc") await open({ botId: "bot-b" });
    FakeNotification.permission = "granted";
    click();
    old.flushPendingBrowserNotifications();
    old.notifyBrowserForEvent(event("late"), "thread-b", 0, true, "Scout", true, undefined);
    oldStream.push({
      type: "alert",
      alert: {
        kind: "completion",
        title: "Late",
        body: "Late",
        spaceId: "space-1",
        botId: "bot-b",
        threadId: "thread-b",
      },
    });
    await flush();
    expect(focus).not.toHaveBeenCalled();
    expect(openChat).not.toHaveBeenCalled();
    expect(FakeNotification.shown).toHaveLength(1);
    if (reason === "rpc") {
      notify();
      expect(FakeNotification.shown).toHaveLength(2);
    }
  },
);

it("flushes granted pending events once and ignores a naturally closed notification click", async () => {
  const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
  focused = false;
  FakeNotification.permission = "default";
  await open({ botId: "bot-b" });
  notify();
  expect(FakeNotification.shown).toHaveLength(0);
  FakeNotification.permission = "granted";
  callbacks.flushPendingBrowserNotifications();
  callbacks.flushPendingBrowserNotifications();
  notify();
  expect(FakeNotification.shown).toHaveLength(1);
  const notification = FakeNotification.shown[0]!;
  const click = notification.onclick!;
  notification.onclose!();
  click();
  expect(focus).not.toHaveBeenCalled();
  expect(openChat).not.toHaveBeenCalled();
});

it("keeps the actual default Space target when no explicit selection is stored", async () => {
  context.spaceId = null;
  focused = false;
  const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
  act(() => root.render(<Harness botId="bot-b" />));
  await flush();
  callbacks.notifyBrowserForEvent(
    { ...event(), spaceId: "default-space" },
    "thread-b",
    0,
    true,
    "Scout",
    true,
    undefined,
  );
  const [notification] = FakeNotification.shown;
  expect(notification).toBeDefined();
  notification!.onclick!();
  expect(focus).toHaveBeenCalledOnce();
  expect(openChat).toHaveBeenCalledWith(
    expect.objectContaining({ spaceId: "default-space", botId: "bot-b" }),
  );
});

it.each(["denied", "unsupported"] as const)(
  "does not publish or retain events when notifications are %s",
  async (permission) => {
    focused = false;
    if (permission === "unsupported") vi.stubGlobal("Notification", undefined);
    else FakeNotification.permission = "denied";
    await open({ botId: "bot-b" });
    notify();
    await send({ groupId: "group-g" });
    vi.stubGlobal("Notification", FakeNotification);
    FakeNotification.permission = "granted";
    callbacks.flushPendingBrowserNotifications();
    expect(FakeNotification.shown).toHaveLength(0);
  },
);

it("keeps a permission-held group's original target after the active chat changes", async () => {
  focused = false;
  vi.spyOn(window, "focus").mockImplementation(() => undefined);
  FakeNotification.permission = "default";
  await open({ groupId: "group-g" });
  notify("group-g");
  await open({ botId: "bot-a" });
  FakeNotification.permission = "granted";
  callbacks.flushPendingBrowserNotifications();
  const [notification] = FakeNotification.shown;
  notification!.onclick!();
  expect(openChat).toHaveBeenCalledWith(
    expect.objectContaining({ groupId: "group-g", botId: "bot-b", spaceId: "space-1" }),
  );
});

it("does not navigate if focusing the window retires the captured session", async () => {
  vi.spyOn(window, "focus").mockImplementation(() => {
    context.generation++;
  });
  await open({ botId: "bot-a" });
  await send({});
  const [notification] = FakeNotification.shown;
  notification!.onclick!();
  expect(openChat).not.toHaveBeenCalled();
  expect(notification!.closed).toBe(true);
});
