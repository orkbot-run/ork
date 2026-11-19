// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved; notification ownership changes follow LICENSE.md.

import type { Bot, ChatAlert, ProductEvent } from "@orkbot/contracts";
import { createRefreshCoalescer, isRetryableError, retryDelayMs } from "@orkbot/core";
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  deliverBrowserNotification as deliverNativeBrowserNotification,
  shouldNotifyBrowser,
} from "../../lib/browser-notifications";
import { notificationIcon, prepareNotificationIcons } from "../../lib/notification-icon";
import type { RpcClient } from "../../lib/rpc";
import { captureRpcContext } from "../../lib/rpc";

type PendingBrowserNotification = {
  event: Pick<ProductEvent, "id" | "type" | "threadId" | "spaceId" | "botId" | "payload">;
  botId: string;
  botName: string;
  groupId?: string;
};

type ChatAlertOptions = {
  rpc: Pick<RpcClient, "notifications">;
  activeBotId: RefObject<string | undefined>;
  activeGroupId: RefObject<string | undefined>;
  openChat: (alert: ChatAlert) => void;
  isSnoozed?: (botId: string, groupId?: string) => boolean;
  refreshRoster?: () => Promise<void>;
  rosterFetchStartedAt?: RefObject<number>;
  rosterRefreshInFlight?: RefObject<number>;
  callsEnabled?: RefObject<boolean>;
};

/**
 * Finished-run notifications for the open chat, held until the browser grants permission, and
 * the server's alerts for every other chat.
 */
export function useBrowserNotifications(
  bots: Bot[],
  botsRef: RefObject<Bot[]>,
  {
    rpc,
    activeBotId,
    activeGroupId,
    openChat,
    isSnoozed,
    refreshRoster,
    rosterFetchStartedAt,
    rosterRefreshInFlight,
    callsEnabled,
  }: ChatAlertOptions,
) {
  useEffect(() => prepareNotificationIcons(bots), [bots]);
  const openChatRef = useRef(openChat);
  openChatRef.current = openChat;
  const snoozedRef = useRef(isSnoozed);
  snoozedRef.current = isSnoozed;
  const refreshRosterRef = useRef(refreshRoster);
  refreshRosterRef.current = refreshRoster;
  const source = useMemo(() => ({ ...captureRpcContext(), rpc }), [rpc]);
  type Lifetime = {
    source: typeof source;
    active: boolean;
    shown: Map<Notification, ChatAlert>;
    notified: Set<string>;
    pending: Map<string, PendingBrowserNotification>;
  };
  const lifetime = useRef<Lifetime | null>(null);
  const currentLifetime = useCallback(() => {
    const owner = lifetime.current;
    return owner?.active && owner.source === source && source.isCurrent() ? owner : null;
  }, [source]);
  useLayoutEffect(() => {
    const owner: Lifetime = {
      source,
      active: true,
      shown: new Map(),
      notified: new Set(),
      pending: new Map(),
    };
    lifetime.current = owner;
    return () => {
      owner.active = false;
      owner.pending.clear();
      owner.notified.clear();
      for (const notification of owner.shown.keys()) {
        notification.onclick = null;
        notification.onclose = null;
        notification.close();
      }
      owner.shown.clear();
      if (lifetime.current === owner) lifetime.current = null;
    };
  }, [source]);
  const showNotification = useCallback(
    (owner: Lifetime, alert: ChatAlert, tag: string, icon?: string) => {
      if (currentLifetime() !== owner) return;
      const target = { ...alert };
      const notification = new Notification(target.title, {
        body: target.body,
        tag,
        ...(icon ? { icon } : {}),
      });
      owner.shown.set(notification, target);
      const release = () => {
        owner.shown.delete(notification);
        notification.onclick = null;
        notification.onclose = null;
      };
      notification.onclose = release;
      notification.onclick = () => {
        if (currentLifetime() !== owner || !owner.shown.has(notification)) return;
        release();
        try {
          window.focus();
          if (currentLifetime() === owner) openChatRef.current(target);
        } finally {
          notification.close();
        }
      };
    },
    [currentLifetime],
  );
  useEffect(() => {
    const owner = currentLifetime();
    if (!owner) return;
    for (const [notification, alert] of owner.shown) {
      if (alert.kind !== "completion" || !snoozedRef.current?.(alert.botId, alert.groupId))
        continue;
      owner.shown.delete(notification);
      notification.onclick = null;
      notification.onclose = null;
      notification.close();
    }
    for (const [threadId, pending] of owner.pending) {
      if (
        pending.event.type === "thread.message.created" &&
        snoozedRef.current?.(pending.botId, pending.groupId)
      ) {
        owner.pending.delete(threadId);
      }
    }
  });
  useEffect(() => {
    const owner = currentLifetime();
    if (!owner) return;
    let active = true;
    let controller: AbortController | undefined;
    let cancelRetry: (() => void) | undefined;
    const current = () => active && currentLifetime() === owner;
    const rosterRefresh = createRefreshCoalescer(async () => {
      if (current()) await refreshRosterRef.current?.();
    });
    let rosterReady = false;
    let connected = false;
    const subscribedAt = Date.now();
    let poll: ReturnType<typeof setTimeout>;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const foreground = () => document.visibilityState === "visible" || callsEnabled?.current;
    const refreshVisibleRoster = () => {
      if (!current() || !foreground()) return;
      void rosterRefresh.invalidate().catch(() => undefined);
    };
    const schedulePoll = () => {
      clearTimeout(poll);
      poll = setTimeout(
        () => {
          if (!rosterRefreshInFlight?.current) refreshVisibleRoster();
          if (current()) schedulePoll();
        },
        rosterReady ? 60_000 : 10_000,
      );
    };
    const onForeground = () => {
      if (!foreground()) return;
      clearTimeout(focusTimer);
      focusTimer = setTimeout(refreshVisibleRoster, 50);
    };
    schedulePoll();
    window.addEventListener("focus", onForeground);
    document.addEventListener("visibilitychange", onForeground);
    const show = (alert: ChatAlert) => {
      const isOpen = alert.groupId
        ? alert.groupId === activeGroupId.current
        : !activeGroupId.current && alert.botId === activeBotId.current;
      if (!isOpen) void rosterRefresh.invalidate().catch(() => undefined);
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      if (alert.kind === "completion" && snoozedRef.current?.(alert.botId, alert.groupId)) return;
      // The open chat's own stream alerts for its replies and failures; only a takeover is missed.
      if (
        isOpen &&
        (alert.kind !== "takeover" ||
          (document.visibilityState === "visible" && document.hasFocus()))
      )
        return;
      try {
        const bot = botsRef.current.find((candidate) => candidate.id === alert.botId);
        const icon = bot ? notificationIcon(bot) : undefined;
        // Per chat and kind: replace repeats without hiding a different kind of alert.
        showNotification(owner, alert, `${alert.threadId}:${alert.kind}`, icon);
      } catch {
        // Some browsers only allow notifications from a service worker.
      }
    };
    void (async () => {
      while (current()) {
        controller = new AbortController();
        let failure: unknown;
        try {
          const stream = await rpc.notifications.subscribe(
            { roster: true },
            {
              signal: controller.signal,
              context: { isCurrent: current },
            },
          );
          for await (const frame of stream) {
            if (!current()) return;
            if (frame.type === "roster") {
              if (frame.ready) {
                rosterReady = true;
                schedulePoll();
                // A prompt first handshake shares the initial fetch. Later handshakes
                // close the subscription gap, including reconnects after a short drop.
                if (
                  connected ||
                  Date.now() - (rosterFetchStartedAt?.current ?? subscribedAt) > 1_000
                ) {
                  void rosterRefresh.invalidate().catch(() => undefined);
                }
                connected = true;
              } else {
                void rosterRefresh.invalidate().catch(() => undefined);
              }
            } else if (frame.alert) show(frame.alert);
          }
        } catch (cause) {
          failure = cause;
        } finally {
          controller.abort();
          if (rosterReady) {
            rosterReady = false;
            if (current()) schedulePoll();
          }
        }
        if (!current() || (failure !== undefined && !isRetryableError(failure))) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryDelayMs(failure, 1_000));
          cancelRetry = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        cancelRetry = undefined;
      }
    })();
    return () => {
      active = false;
      rosterRefresh.dispose();
      clearTimeout(poll);
      clearTimeout(focusTimer);
      window.removeEventListener("focus", onForeground);
      document.removeEventListener("visibilitychange", onForeground);
      controller?.abort();
      cancelRetry?.();
    };
  }, [
    source,
    currentLifetime,
    showNotification,
    activeBotId,
    activeGroupId,
    rosterFetchStartedAt,
    rosterRefreshInFlight,
    callsEnabled,
  ]);
  const deliverBrowserNotification = useCallback(
    (pending: PendingBrowserNotification): boolean => {
      const owner = currentLifetime();
      if (!owner) return true;
      if (
        pending.event.type === "thread.message.created" &&
        snoozedRef.current?.(pending.botId, pending.groupId)
      )
        return true;
      const currentBot = botsRef.current.find((bot) => bot.id === pending.botId);
      if (!currentBot || typeof Notification === "undefined") return true;
      const result = deliverNativeBrowserNotification(
        pending.event,
        currentBot.name || pending.botName,
        {
          enabled: Boolean(pending.groupId) || currentBot.notifyOnFinish,
          pageVisible: document.visibilityState === "visible",
          windowFocused: document.hasFocus(),
          permission: Notification.permission,
          notifiedEventIds: owner.notified,
          show: (title, body, tag) => {
            showNotification(
              owner,
              {
                kind:
                  pending.event.type === "run.failed" || pending.event.type === "run.cancelled"
                    ? "failure"
                    : "completion",
                title,
                body,
                spaceId: pending.event.spaceId,
                botId: pending.botId,
                threadId: pending.event.threadId,
                ...(pending.groupId ? { groupId: pending.groupId } : {}),
              },
              tag,
              notificationIcon(currentBot),
            );
          },
        },
      );
      return result !== "pending";
    },
    [currentLifetime, showNotification],
  );
  const flushPendingBrowserNotifications = useCallback(() => {
    const owner = currentLifetime();
    if (!owner) return;
    for (const [threadId, pending] of owner.pending) {
      if (deliverBrowserNotification(pending)) {
        owner.pending.delete(threadId);
      }
    }
  }, [currentLifetime, deliverBrowserNotification]);
  const notifyBrowserForEvent = useCallback(
    (
      event: Pick<
        ProductEvent,
        "id" | "type" | "threadId" | "spaceId" | "seq" | "botId" | "payload"
      >,
      subscribedThreadId: string | undefined,
      initialCursor: number,
      streamReady: boolean,
      botName: string,
      enabled: boolean,
      groupId: string | undefined,
    ) => {
      const owner = currentLifetime();
      if (!owner) return;
      const botId = event.botId;
      if (typeof botId !== "string") return;
      if (event.type === "thread.message.created" && snoozedRef.current?.(botId, groupId)) return;
      const eligible = shouldNotifyBrowser(event, {
        subscribedThreadId: subscribedThreadId ?? "",
        initialCursor,
        streamReady,
        pageVisible: document.visibilityState === "visible",
        windowFocused: document.hasFocus(),
        permission: "granted",
        notifiedEventIds: owner.notified,
      });
      if (!eligible || !enabled) return;
      const pending = {
        event,
        botId,
        botName,
        groupId,
      } satisfies PendingBrowserNotification;
      if (typeof Notification === "undefined" || Notification.permission === "denied") return;
      if (Notification.permission === "default") {
        owner.pending.set(event.threadId, pending);
        return;
      }
      if (deliverBrowserNotification(pending)) {
        owner.pending.delete(event.threadId);
      } else {
        owner.pending.set(event.threadId, pending);
      }
    },
    [currentLifetime, deliverBrowserNotification],
  );
  return { notifyBrowserForEvent, flushPendingBrowserNotifications };
}
