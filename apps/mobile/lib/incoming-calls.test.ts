// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Apache-2.0 covers imported tests; Ork's stale native-action regressions are PolyForm-covered.
// Modified by Ork contributors to verify pending actions cannot cross feed or session changes.
// Modified by Ork contributors for bounded caller resolution and native presentation ownership.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  generation: 1,
  locked: false,
  platform: "android",
  appState: "active",
  onAppState: undefined as undefined | ((state: string) => void),
  onNative: undefined as undefined | (() => void),
  onEvent: undefined as undefined | ((event: unknown) => void),
  onResponse: undefined as undefined | ((response: unknown) => void),
  lastResponse: null as unknown,
  actions: [] as Record<string, string>[],
  native: {
    incomingState: vi.fn(),
    addListener: (_name: string, callback: () => void) => {
      fake.onNative = callback;
      return { remove() {} };
    },
    endIncomingCall: vi.fn(async () => {}),
    finishAnswer: vi.fn(async () => {}),
    clearIncomingCalls: vi.fn(async () => {}),
    configureIncomingSession: vi.fn(async () => {}),
    reportIncomingCall: vi.fn(async () => {}),
  },
  rpc: vi.fn(),
  startCall: vi.fn(),
  call: null as unknown,
}));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => fake.native }));
vi.mock("expo-notifications", () => ({
  setNotificationCategoryAsync: async () => {},
  getLastNotificationResponse: () => fake.lastResponse,
  addNotificationResponseReceivedListener: (onResponse: (response: unknown) => void) => {
    fake.onResponse = onResponse;
    return { remove() {} };
  },
  addNotificationReceivedListener: () => ({ remove() {} }),
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return fake.platform;
    },
  },
  AppState: {
    get currentState() {
      return fake.appState;
    },
    addEventListener: (_event: string, callback: (state: string) => void) => {
      fake.onAppState = callback;
      return { remove() {} };
    },
  },
}));
vi.mock("./api", () => ({
  loadSessionToken: async () => "fake-session",
  captureApiRequestContext: async (spaceId: string) => ({
    apiBase: "https://example.invalid",
    headers: {
      "x-orkbot-space-id": spaceId,
      ...(fake.locked ? {} : { authorization: "Bearer fake-session" }),
    },
    sessionGeneration: fake.generation,
  }),
  rpc: fake.rpc,
  subscribeIncomingCallEvents: async (onEvent: (event: unknown) => void, signal: AbortSignal) => {
    fake.onEvent = onEvent;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  },
}));
vi.mock("./call-session", () => ({
  endCall: vi.fn(),
  getSnapshot: () => fake.call,
  startCall: fake.startCall,
  subscribe: () => () => {},
}));
vi.mock("./i18n", () => ({ t: (value: string) => value }));
vi.mock("./push", () => ({ registerCallPushToken: vi.fn() }));
vi.mock("./server-headers", () => ({ serverHeaders: () => ({}) }));
vi.mock("./session", () => ({
  currentSessionGeneration: () => fake.generation,
  registerSessionDiskCache: vi.fn(),
}));

import { endCall } from "./call-session";
import {
  getIncomingCall,
  respondToMobileCall,
  startIncomingCalls,
  stopIncomingCalls,
} from "./incoming-calls";
import { registerCallPushToken } from "./push";

const bot = { id: "bot-1", spaceId: "space-1", name: "Caller", color: "", avatarSet: undefined };
const block = () => ({
  kind: "call_request",
  status: "ringing",
  callId: "call-1",
  expiresAt: new Date(Date.now() + 45000).toISOString(),
  opening: "Hello",
  reason: "Review",
});
const tick = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  fake.generation = 1;
  fake.locked = false;
  fake.platform = "android";
  fake.appState = "active";
  fake.onAppState = undefined;
  fake.onEvent = undefined;
  fake.onResponse = undefined;
  fake.onNative = undefined;
  fake.lastResponse = null;
  fake.call = null;
  vi.clearAllMocks();
  vi.mocked(registerCallPushToken).mockReset().mockResolvedValue(undefined);
  fake.native.incomingState.mockResolvedValue({ token: "", actions: [] });
  fake.rpc.mockImplementation(async (path: string) => {
    if (path === "spaces/list") return { current: { bots: [bot] }, spaces: [] };
    if (path === "threads/get") return { cursor: 1, messages: [] };
    if (path === "threads/answerCall") return { opening: "Hello" };
    if (path === "voice/status") return { transcribe: true };
    return { ok: true };
  });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  stopIncomingCalls();
  vi.useRealTimers();
});
async function ring() {
  stop = startIncomingCalls();
  await tick();
  fake.onEvent?.([{ ...bot, incomingCall: block() }]);
  return getIncomingCall()!;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function nativeAction(action: "answer" | "end", callId = "call-1", botId = bot.id) {
  return { action, callId, botId, expiresAt: block().expiresAt };
}
function notification(botId: string, callId = "call-1") {
  return {
    actionIdentifier: "answer",
    notification: {
      request: { content: { data: { ...block(), callId, kind: "incoming_call", botId } } },
    },
  };
}
describe("mobile incoming calls", () => {
  it.each(["pending", "failed"] as const)(
    "answers from the stream while the roster is %s without delaying native action admission",
    async (state) => {
      const roster = deferred<unknown>();
      fake.rpc.mockImplementation(async (path: string) => {
        if (path === "spaces/list") {
          if (state === "failed") throw new Error("offline roster");
          return roster.promise;
        }
        if (path === "threads/answerCall") return { opening: "Hello" };
        return { transcribe: true };
      });
      fake.native.incomingState.mockResolvedValueOnce({
        token: "",
        actions: [nativeAction("answer")],
      });
      stop = startIncomingCalls();
      await tick();
      fake.onEvent?.([{ ...bot, incomingCall: block() }]);
      await tick();
      expect(fake.startCall).toHaveBeenCalledOnce();
      expect(fake.native.finishAnswer).toHaveBeenCalledWith("call-1", true);
      roster.resolve({ current: { bots: [bot] }, spaces: [] });
      await tick();
      expect(fake.startCall).toHaveBeenCalledOnce();
    },
  );
  it("uses one total caller deadline even when roster loading never settles", async () => {
    fake.rpc.mockImplementation(async (path: string) => {
      if (path === "spaces/list") return new Promise(() => {});
      return {};
    });
    fake.native.incomingState.mockResolvedValueOnce({
      token: "",
      actions: [nativeAction("answer")],
    });
    stop = startIncomingCalls();
    await tick();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fake.native.finishAnswer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.native.finishAnswer).toHaveBeenCalledExactlyOnceWith("call-1", false);
    expect(fake.startCall).not.toHaveBeenCalled();
  });
  it("continues waiting after an unrelated first stream snapshot", async () => {
    fake.lastResponse = notification("bot-late");
    stop = startIncomingCalls();
    await tick();
    fake.onEvent?.([]);
    await tick();
    await vi.advanceTimersByTimeAsync(2_000);
    fake.onEvent?.([{ ...bot, id: "bot-late", incomingCall: block() }]);
    await tick();
    expect(fake.startCall).toHaveBeenCalledWith(expect.objectContaining({ botId: "bot-late" }));
  });
  it("shares one pending roster read across foreground and native triggers", async () => {
    const roster = deferred<unknown>();
    fake.rpc.mockImplementation(async () => roster.promise);
    stop = startIncomingCalls();
    await tick();
    for (let i = 0; i < 8; i++) {
      fake.onAppState?.("active");
      fake.onNative?.();
    }
    await tick();
    expect(fake.rpc.mock.calls.filter(([path]) => path === "spaces/list")).toHaveLength(1);
    roster.resolve({ current: { bots: [] }, spaces: [] });
    await tick();
  });
  it("retries roster reads after a failed read instead of caching its rejection", async () => {
    const original = fake.rpc.getMockImplementation()!;
    fake.rpc.mockRejectedValueOnce(new Error("temporary roster failure"));
    stop = startIncomingCalls();
    await tick();
    fake.rpc.mockImplementation(original);
    fake.onResponse?.(notification(bot.id));
    await tick();
    expect(fake.startCall).toHaveBeenCalledOnce();
    expect(fake.rpc.mock.calls.filter(([path]) => path === "spaces/list")).toHaveLength(2);
  });
  it.each([false, true])(
    "does not publish a retired roster into a replacement feed (new session: %s)",
    async (newSession) => {
      const oldRoster = deferred<unknown>();
      fake.rpc.mockImplementationOnce(async () => oldRoster.promise);
      stop = startIncomingCalls();
      await tick();
      const oldEvent = fake.onEvent;
      stop();
      if (newSession) fake.generation++;
      fake.rpc.mockImplementation(async (path: string) => {
        if (path === "spaces/list") return { current: { bots: [] }, spaces: [] };
        return { transcribe: true, opening: "Hello" };
      });
      stop = startIncomingCalls();
      await tick();
      oldRoster.resolve({ current: { bots: [bot] }, spaces: [] });
      oldEvent?.([{ ...bot, incomingCall: block() }]);
      await tick();
      fake.onResponse?.(notification(bot.id));
      await tick();
      expect(fake.startCall).not.toHaveBeenCalled();
      expect(getIncomingCall()).toBeNull();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fake.startCall).not.toHaveBeenCalled();
    },
  );
  it("ignores callbacks from the feed after its session generation changes", async () => {
    stop = startIncomingCalls();
    await tick();
    fake.generation++;
    fake.onEvent?.([{ ...bot, incomingCall: block() }]);
    fake.onNative?.();
    fake.onAppState?.("active");
    await tick();
    expect(getIncomingCall()).toBeNull();
    expect(fake.native.incomingState).toHaveBeenCalledOnce();
    expect(fake.native.configureIncomingSession).toHaveBeenCalledOnce();
  });
  it("does not let retired native listeners or cleanup touch a replacement feed", async () => {
    await ring();
    const oldNative = fake.onNative;
    const oldAppState = fake.onAppState;
    const oldResponse = fake.onResponse;
    const oldStop = stop!;
    oldStop();
    fake.generation++;
    stop = startIncomingCalls();
    await tick();
    fake.onEvent?.([{ ...bot, incomingCall: { ...block(), callId: "new-call" } }]);
    fake.native.incomingState.mockClear();
    fake.native.endIncomingCall.mockClear();
    oldNative?.();
    oldAppState?.("active");
    oldResponse?.(notification(bot.id, "new-call"));
    oldStop();
    await tick();
    expect(getIncomingCall()?.incomingCall.callId).toBe("new-call");
    expect(fake.native.incomingState).not.toHaveBeenCalled();
    expect(fake.native.endIncomingCall).not.toHaveBeenCalled();
    expect(fake.startCall).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "does not let an old join block or finish a new feed's answer (new session: %s)",
    async (newSession) => {
      const oldVoice = deferred<unknown>();
      const call = await ring();
      const original = fake.rpc.getMockImplementation()!;
      fake.rpc.mockImplementationOnce(original).mockImplementationOnce(() => oldVoice.promise);
      const oldAnswer = respondToMobileCall(call, "answer");
      try {
        await tick();
        expect(fake.startCall).not.toHaveBeenCalled();
        stop!();
        if (newSession) fake.generation++;
        stop = startIncomingCalls();
        await tick();
        fake.onEvent?.([{ ...bot, incomingCall: block() }]);
        await respondToMobileCall(getIncomingCall()!, "answer");
        expect(fake.startCall).toHaveBeenCalledOnce();
        fake.native.finishAnswer.mockClear();
      } finally {
        // A RED assertion must still settle the baseline module's in-flight response lock.
        oldVoice.resolve({ transcribe: true });
        await oldAnswer.catch(() => undefined);
      }
      await expect(oldAnswer).rejects.toThrow();
      expect(fake.startCall).toHaveBeenCalledOnce();
      expect(fake.native.finishAnswer).not.toHaveBeenCalled();
      if (!newSession)
        expect(fake.rpc.mock.calls.filter(([path]) => path === "threads/endCall")).toHaveLength(0);
    },
  );
  it("answers before resolving an unrelated native ring", async () => {
    await ring();
    fake.native.incomingState.mockResolvedValueOnce({
      token: "",
      actions: [nativeAction("answer")],
      ringing: [{ ...nativeAction("answer", "other-call", "unknown-bot"), action: undefined }],
    });
    fake.onNative?.();
    await tick();
    expect(fake.startCall).toHaveBeenCalledOnce();
    expect(fake.native.finishAnswer).toHaveBeenCalledWith("call-1", true);
  });
  it("processes ends before answers and never republishes an ended native ring", async () => {
    fake.platform = "ios";
    fake.native.incomingState.mockResolvedValueOnce({
      token: "",
      actions: [nativeAction("answer"), nativeAction("end")],
      ringing: [nativeAction("answer")],
    });
    stop = startIncomingCalls();
    await tick();
    fake.onEvent?.([{ ...bot, incomingCall: block() }]);
    await tick();
    expect(fake.startCall).not.toHaveBeenCalled();
    expect(fake.rpc.mock.calls.filter(([path]) => path === "threads/answerCall")).toHaveLength(0);
    expect(fake.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(getIncomingCall()).toBeNull();
  });
  it("ignores a repeated answer without failing the native call that already joined", async () => {
    await respondToMobileCall(await ring(), "answer");
    fake.native.finishAnswer.mockClear();
    fake.native.incomingState.mockResolvedValueOnce({
      token: "",
      actions: [nativeAction("answer")],
    });
    fake.onNative?.();
    await tick();
    expect(fake.startCall).toHaveBeenCalledOnce();
    expect(fake.native.finishAnswer).not.toHaveBeenCalled();
  });
  it("observes an end arriving while an answer is still joining", async () => {
    const voice = deferred<unknown>();
    const original = fake.rpc.getMockImplementation()!;
    fake.rpc.mockImplementation((path: string) =>
      path === "voice/status" ? voice.promise : original(path),
    );
    await ring();
    fake.native.incomingState.mockResolvedValueOnce({
      token: "",
      actions: [nativeAction("answer")],
    });
    fake.onNative?.();
    await tick();
    expect(fake.rpc).toHaveBeenCalledWith("voice/status", {}, expect.anything());
    fake.native.incomingState.mockResolvedValueOnce({ token: "", actions: [nativeAction("end")] });
    fake.onNative?.();
    await tick();
    voice.resolve({ transcribe: true });
    await tick();
    expect(fake.startCall).not.toHaveBeenCalled();
    expect(fake.rpc).toHaveBeenCalledWith(
      "threads/endCall",
      { botId: bot.id, callId: "call-1" },
      expect.anything(),
    );
  });
  it("keeps an in-flight answer cancelled after its ended-call tombstone expires", async () => {
    const voice = deferred<unknown>();
    const original = fake.rpc.getMockImplementation()!;
    fake.rpc.mockImplementation((path: string) =>
      path === "voice/status" ? voice.promise : original(path),
    );
    await ring();
    const answer = {
      ...nativeAction("answer"),
      expiresAt: new Date(Date.now() + 2_000).toISOString(),
    };
    fake.native.incomingState.mockResolvedValueOnce({ token: "", actions: [answer] });
    fake.onNative?.();
    await tick();
    expect(fake.rpc).toHaveBeenCalledWith("voice/status", {}, expect.anything());
    fake.native.incomingState.mockResolvedValueOnce({
      token: "",
      actions: [{ ...answer, action: "end" }],
    });
    fake.onNative?.();
    await tick();
    await vi.advanceTimersByTimeAsync(6_000);
    voice.resolve({ transcribe: true });
    await tick();
    expect(fake.startCall).not.toHaveBeenCalled();
    expect(fake.native.finishAnswer).not.toHaveBeenCalledWith("call-1", true);
  });
  it.each(["answer", "end"] as const)(
    "does not delay native %s behind push registration",
    async (action) => {
      await ring();
      if (action === "end") {
        await respondToMobileCall(getIncomingCall()!, "answer");
        fake.call = { botId: bot.id };
        vi.mocked(endCall).mockClear();
      }
      const registration = deferred<void>();
      vi.mocked(registerCallPushToken).mockReturnValueOnce(registration.promise);
      fake.native.incomingState.mockResolvedValueOnce({
        token: "voip-token",
        actions: [nativeAction(action)],
      });
      fake.onNative?.();
      try {
        await tick();
        expect(registerCallPushToken).toHaveBeenCalled();
        if (action === "answer") expect(fake.startCall).toHaveBeenCalledOnce();
        else expect(endCall).toHaveBeenCalledOnce();
      } finally {
        registration.resolve();
        await tick();
      }
    },
  );
  it("expires ended-call tombstones without extending duplicate ends", async () => {
    stop = startIncomingCalls();
    await tick();
    const end = { ...nativeAction("end"), expiresAt: new Date(Date.now() + 10_000).toISOString() };
    fake.native.incomingState.mockResolvedValueOnce({ token: "", actions: [end] });
    fake.onNative?.();
    await tick();
    await vi.advanceTimersByTimeAsync(5_000);
    fake.native.incomingState.mockResolvedValueOnce({
      token: "",
      actions: [{ ...end, expiresAt: block().expiresAt }],
    });
    fake.onNative?.();
    await tick();
    await vi.advanceTimersByTimeAsync(5_001);
    fake.onEvent?.([{ ...bot, incomingCall: block() }]);
    expect(getIncomingCall()?.incomingCall.callId).toBe("call-1");
  });
  it("bounds ended-call retention and count", async () => {
    stop = startIncomingCalls();
    await tick();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    fake.native.incomingState.mockResolvedValueOnce({
      token: "",
      actions: Array.from({ length: 257 }, (_, i) => ({
        ...nativeAction("end", `ended-${i}`),
        expiresAt,
      })),
    });
    fake.onNative?.();
    await tick();
    fake.onEvent?.([{ ...bot, incomingCall: { ...block(), callId: "ended-0" } }]);
    expect(getIncomingCall()?.incomingCall.callId).toBe("ended-0");
    fake.onEvent?.([{ ...bot, incomingCall: { ...block(), callId: "ended-256" } }]);
    expect(getIncomingCall()).toBeNull();
    await vi.advanceTimersByTimeAsync(300_001);
    fake.onEvent?.([{ ...bot, incomingCall: { ...block(), callId: "ended-256" } }]);
    expect(getIncomingCall()?.incomingCall.callId).toBe("ended-256");
  });
  it("cancels Android native rings that arrive after the foreground transition", async () => {
    fake.appState = "background";
    await ring();
    expect(fake.native.reportIncomingCall).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-1" }),
    );
    fake.appState = "active";
    fake.onAppState?.("active");
    await tick();
    fake.native.endIncomingCall.mockClear();
    fake.native.incomingState.mockResolvedValueOnce({
      token: "",
      actions: [],
      ringing: [nativeAction("answer", "call-late")],
    });
    fake.onNative?.();
    await tick();
    expect(fake.native.endIncomingCall).toHaveBeenCalledWith("call-late");
    expect(getIncomingCall()?.incomingCall.callId).toBe("call-late");
    expect(
      fake.rpc.mock.calls.filter(([path]) => /answerCall|declineIncomingCall|endCall/.test(path)),
    ).toHaveLength(0);
  });
  it.each(["ios", "android"])("preserves %s background native ringing", async (platform) => {
    fake.platform = platform;
    fake.appState = "background";
    await ring();
    expect(fake.native.reportIncomingCall).toHaveBeenCalledOnce();
    expect(fake.native.endIncomingCall).not.toHaveBeenCalled();
  });
  it("waits for unlock before configuring credentials and opening the account stream", async () => {
    fake.locked = true;
    stop = startIncomingCalls();
    await tick();
    expect(fake.onEvent).toBeUndefined();
    expect(fake.native.configureIncomingSession).not.toHaveBeenCalled();
    fake.locked = false;
    fake.onAppState?.("active");
    await tick();
    expect(fake.onEvent).toBeTypeOf("function");
    expect(fake.native.configureIncomingSession).toHaveBeenCalledOnce();
  });
  it("rings from realtime and expires without polling", async () => {
    await ring();
    expect(getIncomingCall()?.incomingCall.callId).toBe("call-1");
    const requests = fake.rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(45000);
    expect(getIncomingCall()).toBeNull();
    expect(fake.rpc).toHaveBeenCalledTimes(requests);
  });
  it("answers with the existing call id, opening, Space and session", async () => {
    const call = await ring();
    await respondToMobileCall(call, "answer");
    expect(fake.startCall).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: bot.id,
        greeting: "Hello",
        answered: { callId: "call-1" },
        session: 1,
        requestContext: expect.objectContaining({
          headers: expect.objectContaining({ "x-orkbot-space-id": "space-1" }),
        }),
      }),
    );
    expect(getIncomingCall()).toBeNull();
  });
  it("ends the current call when a native answer arrives during it", async () => {
    await ring();
    fake.call = { botId: "bot-2" };
    fake.native.incomingState.mockResolvedValue({
      token: "",
      actions: [
        { action: "answer", callId: "call-1", botId: bot.id, expiresAt: block().expiresAt },
      ],
    });
    fake.onAppState?.("active");
    await vi.waitFor(() => expect(fake.startCall).toHaveBeenCalled());
    expect(endCall).toHaveBeenCalled();
    expect(fake.native.finishAnswer).toHaveBeenCalledWith("call-1", true);
  });
  it.each([false, true])(
    "abandons waiting native actions if push registration outlives its feed (session changes: %s)",
    async (sessionChanges) => {
      stop = startIncomingCalls();
      await tick();
      let finishRegistration!: () => void;
      vi.mocked(registerCallPushToken).mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishRegistration = resolve)),
      );
      fake.native.incomingState.mockResolvedValueOnce({
        token: "voip-token",
        actions: [
          {
            action: "answer",
            callId: "call-old",
            botId: "old-unknown",
            expiresAt: block().expiresAt,
          },
        ],
      });
      fake.onAppState?.("active");
      await tick();
      expect(registerCallPushToken).toHaveBeenCalledWith(
        { voipToken: "voip-token" },
        expect.objectContaining({ sessionGeneration: fake.generation }),
      );
      stop?.();
      if (sessionChanges) fake.generation++;
      stop = startIncomingCalls();
      await tick();
      finishRegistration();
      await tick();
      expect(fake.rpc.mock.calls.filter(([path]) => path === "threads/answerCall")).toEqual([]);
      expect(fake.native.finishAnswer).not.toHaveBeenCalledWith("call-old", expect.anything());
    },
  );
  const orgBot = {
    id: "bot-org-b",
    spaceId: "space-org-b",
    name: "Other org caller",
    color: "",
    avatarSet: undefined,
  };
  const orgAnswerRpc = (callId: string) => [
    "threads/answerCall",
    { botId: orgBot.id, callId },
    {
      requestContext: expect.objectContaining({
        headers: expect.objectContaining({ "x-orkbot-space-id": orgBot.spaceId }),
      }),
    },
  ];
  it("answers a native call from a bot outside the active organization", async () => {
    stop = startIncomingCalls();
    await tick();
    // The account stream knows callers across every organization; spaces/list only the active one.
    fake.onEvent?.([{ ...orgBot, incomingCall: { ...block(), callId: "call-b" } }]);
    fake.native.incomingState.mockResolvedValue({
      token: "",
      actions: [
        { action: "answer", callId: "call-b", botId: orgBot.id, expiresAt: block().expiresAt },
      ],
    });
    fake.onAppState?.("active");
    await vi.waitFor(() => expect(fake.rpc).toHaveBeenCalledWith(...orgAnswerRpc("call-b")));
    expect(fake.native.finishAnswer).toHaveBeenCalledWith("call-b", true);
  });
  it("answers a same-organization native call from the roster without waiting on the stream", async () => {
    stop = startIncomingCalls();
    await tick();
    // No stream event: the active-organization roster must be enough, with no five-second wait.
    fake.native.incomingState.mockResolvedValue({
      token: "",
      actions: [
        { action: "answer", callId: "call-roster", botId: bot.id, expiresAt: block().expiresAt },
      ],
    });
    fake.onAppState?.("active");
    await vi.waitFor(() =>
      expect(fake.rpc).toHaveBeenCalledWith(
        "threads/answerCall",
        { botId: bot.id, callId: "call-roster" },
        expect.anything(),
      ),
    );
    expect(fake.native.finishAnswer).toHaveBeenCalledWith("call-roster", true);
  });
  it("answers a notification call from another organization once the stream reports it", async () => {
    fake.lastResponse = {
      actionIdentifier: "answer",
      notification: {
        request: { content: { data: { ...block(), kind: "incoming_call", botId: orgBot.id } } },
      },
    };
    stop = startIncomingCalls();
    await tick();
    // Cold start: the answer waits for the account stream's snapshot instead of failing
    // on the active organization's roster.
    fake.onEvent?.([{ ...orgBot, incomingCall: { ...block(), callId: "call-1" } }]);
    await vi.waitFor(() => expect(fake.rpc).toHaveBeenCalledWith(...orgAnswerRpc("call-1")));
  });
  it.each([false, true])(
    "abandons a resolved notification caller when its feed changes (session changes: %s)",
    async (sessionChanges) => {
      await ring();
      const response = {
        actionIdentifier: "answer",
        notification: {
          request: { content: { data: { ...block(), kind: "incoming_call", botId: bot.id } } },
        },
      };
      await Promise.all([
        Promise.resolve().then(() => fake.onResponse?.(response)),
        Promise.resolve().then(() => {
          stop?.();
          if (sessionChanges) fake.generation++;
          stop = startIncomingCalls();
        }),
      ]);
      await tick();
      expect(fake.rpc.mock.calls.filter(([path]) => path === "threads/answerCall")).toEqual([]);
      expect(fake.native.finishAnswer).not.toHaveBeenCalledWith("call-1", expect.anything());
    },
  );
  it("abandons a cold-start notification answer when its session stops before the stream reports", async () => {
    fake.lastResponse = {
      actionIdentifier: "answer",
      notification: {
        request: { content: { data: { ...block(), kind: "incoming_call", botId: orgBot.id } } },
      },
    };
    stop = startIncomingCalls();
    await tick();
    // The answer is parked waiting for the account stream's first snapshot.
    stop?.();
    stop = undefined;
    // The app restarts under a new session and its stream reports the same ringing call.
    fake.generation++;
    stop = startIncomingCalls();
    await tick();
    fake.onEvent?.([{ ...orgBot, incomingCall: { ...block(), callId: "call-1" } }]);
    await vi.waitFor(() => expect(fake.rpc).toHaveBeenCalledWith(...orgAnswerRpc("call-1")));
    const answers = () => fake.rpc.mock.calls.filter((call) => call[0] === "threads/answerCall");
    expect(answers()).toHaveLength(1);
    // The stopped session's wait must not wake after its window and re-answer or fail the action.
    await vi.advanceTimersByTimeAsync(5100);
    expect(answers()).toHaveLength(1);
    expect(fake.native.finishAnswer).not.toHaveBeenCalledWith("call-1", false);
  });
  it("declines through the same backend path as web", async () => {
    await respondToMobileCall(await ring(), "decline");
    expect(fake.rpc).toHaveBeenCalledWith(
      "notifications/declineIncomingCall",
      { callId: "call-1" },
      expect.anything(),
    );
    expect(fake.startCall).not.toHaveBeenCalled();
  });
  it("hangs up instead of starting audio when the session changes while answering", async () => {
    const call = await ring();
    fake.rpc.mockImplementation(async (path: string) => {
      if (path === "threads/answerCall") {
        fake.generation++;
        return { opening: "Hello" };
      }
      return {};
    });
    await expect(respondToMobileCall(call, "answer")).rejects.toThrow();
    expect(fake.startCall).not.toHaveBeenCalled();
    expect(fake.rpc).toHaveBeenCalledWith(
      "threads/endCall",
      { botId: call.id, callId: call.incomingCall.callId },
      expect.anything(),
    );
  });
  it("stops ringing when another device answers", async () => {
    await ring();
    fake.onEvent?.([]);
    expect(getIncomingCall()).toBeNull();
    expect(fake.native.endIncomingCall).toHaveBeenCalledWith("call-1");
  });
});
