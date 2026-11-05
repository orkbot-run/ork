// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Apache-2.0 covers imported tests; Ork's late call-context regression is PolyForm-covered.
// Modified by Ork contributors to cover navigation while a call's context is being captured.

// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequestContext, MobileBot } from "./api";
import { captureApiRequestContext } from "./api";
import { startCall } from "./call-session";
import { clearSessionToken, currentSessionGeneration, saveSessionToken } from "./session";
import { useThreadVoiceCall } from "./thread-voice";
import { takeShortcutVoiceChat } from "./voice-chat-intent";

vi.mock("expo-router", () => ({
  useNavigation: () => ({ isFocused: () => true }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  AppState: { currentState: "active" },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock("./live-notifications", () => ({ stopLiveNotifications: vi.fn(async () => undefined) }));
vi.mock("./thread-feedback", () => ({ clearFailedSends: vi.fn() }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
// Signed out, every request fails; device voice needs none of them to start the microphone.
vi.mock("./api", () => ({
  blockText: vi.fn(),
  captureApiRequestContext: vi.fn(async () => ({
    apiBase: "https://api.example.test",
    headers: { "x-orkbot-space-id": "space-riley" },
    sessionGeneration: currentSessionGeneration(),
  })),
  rpc: vi.fn(async () => {
    throw new Error("Unauthorized");
  }),
}));
vi.mock("./call-session", () => ({
  setCallProviderTranscribe: vi.fn(),
  startCall: vi.fn(() => "call-1"),
}));
vi.mock("./device-voice", () => ({ loadDeviceVoiceEnabled: async () => true }));
vi.mock("./dictation", () => ({ available: async () => true }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./voice", () => ({ speakQueue: vi.fn(), speakText: vi.fn() }));
vi.mock("./voice-chat-intent", () => ({
  onShortcutVoiceChat: () => () => undefined,
  takeShortcutVoiceChat: vi.fn(() => false),
}));

const riley = { id: "riley", name: "Riley" } as MobileBot;
const max = { id: "max", name: "Max" } as MobileBot;
const bots = [riley, max];

describe("useThreadVoiceCall hand-over", () => {
  let root: Root;
  let openBotChat: ((target: MobileBot, ring: boolean) => void) | undefined;
  let startVoiceCall: (() => Promise<void>) | undefined;
  let activeBotId: { current: string | undefined };

  function render(botId: string) {
    activeBotId.current = botId;
    function Thread() {
      const voiceCall = useThreadVoiceCall({
        botId,
        readOnly: false,
        displayName: bots.find((bot) => bot.id === botId)?.name,
        mentionBots: bots,
        mentionBotsRef: { current: bots },
        activeBotId,
      });
      openBotChat = voiceCall.openBotChat;
      startVoiceCall = voiceCall.startVoiceCall;
      return null;
    }
    act(() => root.render(createElement(Thread, { key: botId })));
  }

  async function flush() {
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
  }

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(startCall).mockClear();
    vi.mocked(takeShortcutVoiceChat).mockReset().mockReturnValue(false);
    activeBotId = { current: undefined };
    await saveSessionToken("fake-token-a");
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("rings the bot the caller was put through to in the same session", async () => {
    render("riley");
    const session = currentSessionGeneration();
    openBotChat?.(max, true);
    render("max");
    await flush();

    expect(startCall).toHaveBeenCalledOnce();
    expect(startCall).toHaveBeenCalledWith(expect.objectContaining({ botId: "max", session }));
  });

  it("starts a shortcut call with a fresh greeting", async () => {
    vi.mocked(takeShortcutVoiceChat).mockReturnValueOnce(true);
    render("riley");
    await flush();
    expect(startCall).toHaveBeenCalledOnce();
    expect(startCall).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "riley", greeting: "Hello, {bot} here." }),
    );
  });
  it("starts an outgoing call pinned to the Space it starts in", async () => {
    render("riley");
    await act(async () => {
      await startVoiceCall?.();
    });
    expect(startCall).toHaveBeenCalledOnce();
    // Switching organization or Space mid-call must not move the call's turns or hang-up
    // to another Space, so the call starts with the Space captured here.
    expect(startCall).toHaveBeenCalledWith(
      expect.objectContaining({
        requestContext: expect.objectContaining({
          headers: expect.objectContaining({ "x-orkbot-space-id": "space-riley" }),
        }),
      }),
    );
  });

  it("does not start the previous bot's call if context capture finishes after navigation", async () => {
    let finishCapture!: (context: ApiRequestContext) => void;
    vi.mocked(captureApiRequestContext).mockImplementationOnce(
      () => new Promise((resolve) => (finishCapture = resolve)),
    );
    render("riley");
    const pending = startVoiceCall?.();
    await flush();
    expect(finishCapture).toBeTypeOf("function");
    render("max");
    finishCapture({
      apiBase: "https://api.example.test",
      headers: { "x-orkbot-space-id": "space-riley" },
      sessionGeneration: currentSessionGeneration(),
    });
    await pending;
    expect(startCall).not.toHaveBeenCalled();
  });

  it("drops a hand-over queued before a sign-out", async () => {
    render("riley");
    openBotChat?.(max, true);
    await clearSessionToken();
    render("max");
    await flush();

    expect(startCall).not.toHaveBeenCalled();
  });
});
