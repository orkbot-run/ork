// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Apache-2.0 covers the imported implementation; Ork changes are PolyForm-covered.
// Modified by Ork contributors to keep native actions with their originating feed and session.
// Modified by Ork contributors for bounded caller resolution and native presentation ownership.

import type { IncomingBotCall, SpaceBot, SpaceNavigation } from "@orkbot/contracts";
import type { ringingCall } from "@orkbot/core";
import {
  abortableDelay,
  callIsRinging,
  isRetryableError,
  nextIncomingCall,
  respondToIncomingCall,
  retryDelayMs,
} from "@orkbot/core";
import { requireOptionalNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import type { ApiRequestContext } from "./api";
import {
  captureApiRequestContext,
  loadSessionToken,
  rpc,
  subscribeIncomingCallEvents,
} from "./api";
import { endCall, getSnapshot, startCall, subscribe as subscribeCall } from "./call-session";
import { t } from "./i18n";
import { registerCallPushToken } from "./push";
import { serverHeaders } from "./server-headers";
import { currentSessionGeneration, registerSessionDiskCache } from "./session";

type Ringing = NonNullable<ReturnType<typeof ringingCall>>;
export function usesNativeIncomingCallRingtone() {
  return Platform.OS === "ios" && native !== null;
}
export type { IncomingBotCall } from "@orkbot/contracts";

type NativeAction = { action: "answer" | "end"; callId: string; botId: string; expiresAt: string };
type NativeCalls = {
  configureIncomingSession?(base: string, headers: Record<string, string>): Promise<void>;
  reportIncomingCall(call: Record<string, string>): Promise<void>;
  incomingState(): Promise<{
    token: string;
    actions: NativeAction[];
    ringing?: Array<Omit<NativeAction, "action">>;
  }>;
  finishAnswer(id: string, success: boolean): Promise<void>;
  endIncomingCall(id: string): Promise<void>;
  clearIncomingCalls(): Promise<void>;
  addListener(name: string, callback: () => void): { remove(): void };
};
const module = requireOptionalNativeModule<NativeCalls>("OrkNotifications");
const native = module?.incomingState ? module : null;
const listeners = new Set<() => void>();
let calls: IncomingBotCall[] = [];
let roster = new Map<string, SpaceBot>();
type CallFeed = {
  controller: AbortController;
  generation: number;
  roster?: Promise<void>;
  responding?: { callId: string; ended: boolean };
};
let feed: CallFeed | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
let snapshot: IncomingBotCall | null = null;
let activeNativeCall: string | undefined;
/** Ended or handled calls cannot ring again while their native handoff is still in flight. */
const retiredCalls = new Map<string, number>();
const RETIRED_CALL_LIMIT = 256;
const RETIRED_CALL_RETENTION_MS = 5 * 60_000;
/** Each lookup observes every snapshot and is cancelled with its captured feed. */
const callerWaiters = new Set<() => void>();
/** One deadline covers roster loading and stream discovery together. */
const SNAPSHOT_WAIT_MS = 5_000;
function currentFeed(owner: CallFeed | undefined): owner is CallFeed {
  return (
    owner !== undefined &&
    feed === owner &&
    !owner.controller.signal.aborted &&
    owner.generation === currentSessionGeneration()
  );
}

function pruneRetiredCalls() {
  for (const [id, expiresAt] of retiredCalls) if (expiresAt <= Date.now()) retiredCalls.delete(id);
}
function retired(callId: string) {
  pruneRetiredCalls();
  return retiredCalls.has(callId);
}
function retire(call: { callId: string; expiresAt: string }) {
  pruneRetiredCalls();
  if (!retiredCalls.has(call.callId)) {
    retiredCalls.set(
      call.callId,
      Math.min(
        Math.max(Date.parse(call.expiresAt) || 0, Date.now() + SNAPSHOT_WAIT_MS),
        Date.now() + RETIRED_CALL_RETENTION_MS,
      ),
    );
    if (retiredCalls.size > RETIRED_CALL_LIMIT)
      retiredCalls.delete(retiredCalls.keys().next().value!);
  }
  calls = calls.filter((entry) => entry.incomingCall.callId !== call.callId);
}

function notifyCallers() {
  for (const check of callerWaiters) check();
}

export function subscribeIncomingCalls(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function getIncomingCall() {
  return snapshot;
}
function emit() {
  clearTimeout(expiry);
  pruneRetiredCalls();
  snapshot = nextIncomingCall(calls, new Set(retiredCalls.keys())) ?? null;
  for (const listener of listeners) listener();
  if (snapshot)
    expiry = setTimeout(
      emit,
      Math.max(0, Date.parse(snapshot.incomingCall.expiresAt) - Date.now()),
    );
}
function update(
  bot: Pick<SpaceBot, "id" | "spaceId" | "name" | "color" | "avatarSet">,
  call: Ringing | null,
) {
  const previous = calls.find((entry) => entry.id === bot.id);
  calls = calls.filter((entry) => entry.id !== bot.id);
  if (
    previous &&
    previous.incomingCall.callId !== call?.callId &&
    !feed?.responding &&
    activeNativeCall !== previous.incomingCall.callId
  )
    void native?.endIncomingCall(previous.incomingCall.callId);
  if (call && callIsRinging(call) && !retired(call.callId)) {
    calls.push({ ...bot, incomingCall: call });
    if (Platform.OS === "ios" || AppState.currentState !== "active")
      reportNativeCall({ ...bot, incomingCall: call });
    else void native?.endIncomingCall(call.callId);
  }
  emit();
}

function reportNativeCall(call: IncomingBotCall) {
  void native?.reportIncomingCall({
    callId: call.incomingCall.callId,
    botId: call.id,
    botName: call.name,
    expiresAt: call.incomingCall.expiresAt,
  });
}

/** Follows the account call stream; every frame is a full snapshot, so reconnects need no replay. */
async function follow(owner: CallFeed) {
  const { controller } = owner;
  let retry = 250;
  let failure: unknown;
  while (currentFeed(owner)) {
    try {
      await subscribeIncomingCallEvents((incoming) => {
        // Ignore events from an aborted feed so a late callback cannot resolve a newer wait.
        if (!currentFeed(owner)) return;
        for (const previous of calls) {
          if (!incoming.some((call) => call.incomingCall.callId === previous.incomingCall.callId))
            update(previous, null);
        }
        for (const call of incoming) update(call, call.incomingCall);
        notifyCallers();
      }, controller.signal);
      retry = 250;
      failure = undefined;
    } catch (error) {
      if (controller.signal.aborted || !isRetryableError(error)) return;
      failure = error;
    }
    await abortableDelay(retryDelayMs(failure, retry), controller.signal).catch(() => undefined);
    retry = Math.min(retry * 2, 5000);
  }
}

function setIncomingCallRoster(navigation: SpaceNavigation) {
  const bots = [...navigation.spaces.flatMap((space) => space.bots), ...navigation.current.bots];
  roster = new Map(bots.map((bot) => [bot.id, bot]));
}
function loadRoster(owner = feed): Promise<void> {
  if (!currentFeed(owner)) return Promise.resolve();
  if (owner.roster) return owner.roster;
  const promise = (async () => {
    if (!(await loadSessionToken()) || !currentFeed(owner)) return;
    const navigation = await rpc("spaces/list", undefined, { signal: owner.controller.signal });
    if (!currentFeed(owner)) return;
    setIncomingCallRoster(navigation);
    notifyCallers();
  })();
  owner.roster = promise;
  const clear = () => {
    if (owner.roster === promise) owner.roster = undefined;
  };
  void promise.then(clear, clear);
  return promise;
}

/**
 * Resolves the caller for a native or notification answer. The account stream knows callers
 * across every organization; the roster covers only the active one. Return a roster hit without
 * waiting on the stream so same-organization answers are not delayed on a cold start. A pending or
 * failed roster cannot block an available stream result. Returns undefined
 * when the lookup's feed or session is gone: the answer belongs to neither, so its caller abandons
 * it without answering or completing the native action.
 */
async function callerFor(
  botId: string,
  callId: string,
): Promise<Pick<SpaceBot, "id" | "spaceId" | "name" | "color" | "avatarSet"> | null | undefined> {
  const owner = feed;
  const stale = () => !currentFeed(owner);
  const available = () =>
    calls.find((entry) => entry.id === botId && entry.incomingCall.callId === callId) ??
    roster.get(botId);
  if (stale()) return undefined;
  if (retired(callId)) return null;
  const known = available();
  if (known) return known;
  return new Promise((resolve) => {
    const finish = (
      value: Pick<SpaceBot, "id" | "spaceId" | "name" | "color" | "avatarSet"> | null | undefined,
    ) => {
      clearTimeout(deadline);
      callerWaiters.delete(check);
      resolve(value);
    };
    const check = () => {
      if (stale()) finish(undefined);
      else if (retired(callId)) finish(null);
      else {
        const caller = available();
        if (caller) finish(caller);
      }
    };
    const deadline = setTimeout(() => finish(stale() ? undefined : null), SNAPSHOT_WAIT_MS);
    callerWaiters.add(check);
    void loadRoster(owner).then(check, check);
  });
}

export async function respondToMobileCall(call: IncomingBotCall, action: "answer" | "decline") {
  const owner = feed;
  if (!currentFeed(owner) || owner.responding || retired(call.incomingCall.callId)) return;
  const response = { callId: call.incomingCall.callId, ended: false };
  owner.responding = response;
  const generation = owner.generation;
  const current = () => currentFeed(owner);
  let context: ApiRequestContext | undefined;
  let answered = false;
  try {
    context = await captureApiRequestContext(call.spaceId);
    if (!current()) return;
    const target = { botId: call.id, callId: call.incomingCall.callId };
    if (response.ended || retired(target.callId))
      throw new Error(t("This call is no longer ringing."));
    if (action === "decline")
      await respondToIncomingCall(call.incomingCall, () =>
        rpc(
          "notifications/declineIncomingCall",
          { callId: target.callId },
          { requestContext: context },
        ),
      );
    else {
      const result = await respondToIncomingCall(call.incomingCall, () =>
        rpc("threads/answerCall", target, { requestContext: context }),
      );
      answered = true;
      // The session changed mid-answer: rpc drops the hang-up below locally, because its
      // context belongs to the old generation, so the server keeps the call answered.
      if (!current()) throw new Error(t("Something went wrong. Try again."));
      const voice = await rpc("voice/status", {}, { requestContext: context });
      if (!current()) throw new Error(t("Something went wrong. Try again."));
      if (response.ended || retired(target.callId))
        throw new Error(t("This call is no longer ringing."));
      // Answering during a call replaces it, like a phone's end-and-accept.
      if (getSnapshot()) endCall();
      activeNativeCall = target.callId;
      startCall({
        botId: call.id,
        botName: call.name,
        botColor: call.color,
        botAvatarSet: call.avatarSet,
        botAvatarSeed: call.avatarSeed,
        transcribe: voice.transcribe,
        greeting: result.opening,
        answered: { callId: target.callId },
        session: generation,
        requestContext: context,
      });
      await native?.finishAnswer(target.callId, true);
    }
    if (!current()) return;
    retire(call.incomingCall);
    if (action === "decline") await native?.endIncomingCall(target.callId);
  } catch (error) {
    // Answered elsewhere or rung out: there is nothing left to decline.
    if (action === "decline" && (error as { code?: string } | null)?.code === "CONFLICT") {
      if (current()) {
        retire(call.incomingCall);
        await native?.endIncomingCall(call.incomingCall.callId);
      }
      return;
    }
    if (answered && context && (current() || generation !== currentSessionGeneration())) {
      await rpc(
        "threads/endCall",
        { botId: call.id, callId: call.incomingCall.callId },
        { requestContext: context },
      ).catch(() => undefined);
    }
    if (current()) await native?.finishAnswer(call.incomingCall.callId, false);
    throw error;
  } finally {
    if (owner.responding === response) owner.responding = undefined;
    if (current()) emit();
  }
}

async function drainNative() {
  const owner = feed;
  const current = () => currentFeed(owner);
  if (!current()) return;
  const state = await native?.incomingState();
  // A sign-out during the read belongs to the old session; the new one drains for itself.
  if (!state || !current()) return;
  if (state.token)
    void captureApiRequestContext(null)
      .then((context) => {
        if (current()) return registerCallPushToken({ voipToken: state.token }, context);
      })
      .catch(() => undefined);
  if (!current()) return;
  // End intent wins even when the same native snapshot lists its earlier answer first.
  for (const action of state.actions) {
    if (action.action !== "end") continue;
    if (owner?.responding?.callId === action.callId) owner.responding.ended = true;
    retire(action);
    if (activeNativeCall === action.callId) endCall();
  }
  emit();
  notifyCallers();
  for (const action of state.actions) {
    if (!current()) return;
    if (action.action === "end") continue;
    if (retired(action.callId)) continue;
    if (!callIsRinging(action)) {
      await native?.finishAnswer(action.callId, false);
      continue;
    }
    const bot = await callerFor(action.botId, action.callId);
    if (!current()) return;
    if (retired(action.callId)) continue;
    // A stale lookup answers nothing and completes no native action: a newer feed owns it.
    if (bot === undefined) continue;
    if (!bot) {
      await native?.finishAnswer(action.callId, false);
      continue;
    }
    await respondToMobileCall(
      { ...bot, incomingCall: { ...action, reason: "", opening: "" } },
      "answer",
    ).catch(() => undefined);
  }
  // Present other rings only after explicit native actions have been admitted.
  for (const ring of state.ringing ?? []) {
    if (!current()) return;
    if (!callIsRinging(ring) || retired(ring.callId)) continue;
    if (Platform.OS === "android" && AppState.currentState === "active")
      void native?.endIncomingCall(ring.callId);
    void callerFor(ring.botId, ring.callId).then((bot) => {
      if (current() && bot && !retired(ring.callId))
        update(bot, { ...ring, reason: "", opening: "" });
    });
  }
}

const notificationActions = new Set<string>();
async function notificationResponse(response: Notifications.NotificationResponse | null) {
  if (!response) return;
  const owner = feed;
  const current = () => currentFeed(owner);
  if (!current()) return;
  const data = response.notification.request.content.data;
  if (
    data?.kind !== "incoming_call" ||
    typeof data.callId !== "string" ||
    typeof data.botId !== "string" ||
    typeof data.expiresAt !== "string" ||
    !callIsRinging({ expiresAt: data.expiresAt })
  )
    return;
  if (response.actionIdentifier !== "answer" && response.actionIdentifier !== "decline") return;
  const key = `${data.callId}:${response.actionIdentifier}`;
  if (notificationActions.has(key)) return;
  notificationActions.add(key);
  try {
    const bot = await callerFor(data.botId, data.callId);
    if (!current()) return;
    // A stale lookup answers nothing and completes no native action: a newer feed owns it.
    if (bot === undefined) return;
    if (!bot) throw new Error("Unknown caller");
    await respondToMobileCall(
      {
        ...bot,
        incomingCall: { callId: data.callId, expiresAt: data.expiresAt, reason: "", opening: "" },
      },
      response.actionIdentifier,
    );
  } finally {
    // Completed intent is deduplicated by the bounded retired-call record, not an eternal key.
    if (current()) notificationActions.delete(key);
  }
}

export function stopIncomingCalls() {
  feed?.controller.abort();
  feed = undefined;
  // Cancel cold-start waits now; a continuation from this feed must not resume later.
  notifyCallers();
  callerWaiters.clear();
  roster.clear();
  notificationActions.clear();
  calls = [];
  retiredCalls.clear();
  clearTimeout(expiry);
  snapshot = null;
  activeNativeCall = undefined;
  void native?.clearIncomingCalls();
  for (const listener of listeners) listener();
}
registerSessionDiskCache(stopIncomingCalls);
subscribeCall(() => {
  if (!getSnapshot()) finishMobileNativeCall();
});

export function startIncomingCalls() {
  const owner: CallFeed = {
    controller: new AbortController(),
    generation: currentSessionGeneration(),
  };
  feed = owner;
  let started = false;
  void Notifications.setNotificationCategoryAsync?.("incoming-call", [
    {
      identifier: "decline",
      buttonTitle: t("Decline"),
      options: { opensAppToForeground: true, isDestructive: true },
    },
    { identifier: "answer", buttonTitle: t("Answer"), options: { opensAppToForeground: true } },
  ]).catch(() => undefined);
  const refresh = () => {
    void captureApiRequestContext(null)
      .then(async (context) => {
        // SecureStore may still be locked after a cold PushKit launch. Retry on foreground.
        if (!context.headers.authorization || !currentFeed(owner)) return;
        await native?.configureIncomingSession?.(context.apiBase, {
          ...serverHeaders(context.apiBase),
          ...context.headers,
        });
        if (!currentFeed(owner)) return;
        if (!started) {
          started = true;
          void follow(owner)
            .catch(() => undefined)
            .finally(() => {
              started = false;
            });
        }
        void loadRoster(owner).catch(() => undefined);
        if (!currentFeed(owner)) return;
        await drainNative();
      })
      .catch(() => undefined);
  };
  refresh();
  void notificationResponse(Notifications.getLastNotificationResponse?.() ?? null).catch(
    () => undefined,
  );
  const response = Notifications.addNotificationResponseReceivedListener?.((response) => {
    if (currentFeed(owner)) void notificationResponse(response).catch(() => undefined);
  });
  const app = AppState.addEventListener("change", (state) => {
    if (!currentFeed(owner)) return;
    if (state === "active") {
      // Android's in-app screen takes over the ring from the native notification.
      if (Platform.OS === "android")
        for (const call of calls) void native?.endIncomingCall(call.incomingCall.callId);
      refresh();
    } else for (const call of calls) reportNativeCall(call);
  });
  const events = native?.addListener("onIncomingCallChanged", () => {
    if (currentFeed(owner)) void drainNative().catch(() => undefined);
  });
  const push = Notifications.addNotificationReceivedListener(() => {
    if (currentFeed(owner)) refresh();
  });
  return () => {
    app.remove();
    events?.remove();
    push.remove();
    response?.remove();
    if (feed === owner) stopIncomingCalls();
  };
}

export function finishMobileNativeCall() {
  if (activeNativeCall) void native?.endIncomingCall(activeNativeCall);
  activeNativeCall = undefined;
}
