// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// @vitest-environment jsdom

import type { Bot, ThreadMessage, ThreadSnapshot } from "@orkbot/contracts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useReadAloud } from "./use-read-aloud";

const audio = vi.hoisted(() => ({
  speak: vi.fn(async () => undefined),
  stop: vi.fn(),
  claimed: false,
  listeners: new Set<() => void>(),
  playback: undefined as undefined | ((state: { status: string; messageId?: string }) => void),
}));
vi.mock("../../lib/tts", () => ({
  speaker: {
    speak: audio.speak,
    stop: audio.stop,
    canSpeak: () => !audio.claimed,
    subscribeOwnership: (listener: () => void) => {
      audio.listeners.add(listener);
      return () => audio.listeners.delete(listener);
    },
    subscribe: (listener: typeof audio.playback) => {
      audio.playback = listener;
      return () => {
        audio.playback = undefined;
      };
    },
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  audio.claimed = false;
});

it("blocks automatic and manual starts for another call, but allows stopping the current message", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const bot = { id: "other-chat", autoSpeak: true } as Bot;
  const first = {
    id: "first",
    role: "bot",
    blocks: [{ kind: "text", text: "First reply" }],
  } as ThreadMessage;
  const next = {
    id: "next",
    role: "bot",
    blocks: [{ kind: "text", text: "Next reply" }],
  } as ThreadMessage;
  let controls: ReturnType<typeof useReadAloud> | undefined;
  function Chat({ messages }: { messages: ThreadMessage[] }) {
    controls = useReadAloud({
      active: bot,
      snapshot: { botId: bot.id, messages } as ThreadSnapshot,
      activeBotId: { current: bot.id },
      callBotId: "call-chat",
    });
    return null;
  }
  try {
    await act(async () => root.render(createElement(Chat, { messages: [first] })));
    await act(async () => {
      audio.claimed = true;
      audio.listeners.forEach((listener) => {
        listener();
      });
      root.render(createElement(Chat, { messages: [first, next] }));
    });
    expect(controls?.canReadAloud).toBe(false);
    act(() => controls?.speakMessage(next));
    expect(audio.speak).not.toHaveBeenCalled();
    await act(async () => audio.playback?.({ status: "speaking", messageId: next.id }));
    act(() => controls?.speakMessage(next));
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(audio.speak).not.toHaveBeenCalled();
    await act(async () => {
      audio.claimed = false;
      audio.listeners.forEach((listener) => {
        listener();
      });
      audio.playback?.({ status: "idle" });
    });
    expect(controls?.canReadAloud).toBe(true);
    act(() => controls?.speakMessage(next));
    expect(audio.speak).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});
