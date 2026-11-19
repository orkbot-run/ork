// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 navigation is preserved. Workspace preloading follows LICENSE.md.

import type { AppBootstrap } from "@orkbot/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceNavigationSpace } from "../../lib/bootstrap";
import {
  discardPrimedBootstrap,
  preloadSpaceBootstrap,
  primeSpaceBootstrap,
} from "../../lib/bootstrap";
import { initialBootstrapTarget } from "../../lib/bootstrap-target";
import { getSnapshot as getCallSnapshot } from "../../lib/call-session";
import { leaveOrganization } from "../../lib/organizations";
import { lastChatKey, lastChatOf, queryClient, spaceSeedKey } from "../../lib/query";
import { selectedSpaceId, selectSpace } from "../../lib/rpc";
import { remountShellForSpace, spaceSwitchDecision } from "../../lib/space-switch";
import { speaker } from "../../lib/tts";
import { readShellOverlay, searchString, withShellOverlay } from "../shell-overlay";
import type { useShellNavigation } from "./use-shell-navigation";
import { firstThreadRoute } from "./use-shell-navigation";

const PRELOAD_MAX_AGE_MS = 60_000;
const BACKGROUND_PRELOAD_DELAY_MS = 400;

export function workspaceChatPath(userId: string | null, space: WorkspaceNavigationSpace): string {
  const seed =
    space.bots.length || space.groups.length
      ? space
      : queryClient.getQueryData(spaceSeedKey(userId, space.id));
  const lastChat = lastChatOf(seed, queryClient.getQueryData(lastChatKey(userId, space.id)));
  if (lastChat?.groupId) return `/app/g/${lastChat.groupId}`;
  if (lastChat?.botId) return `/app/${lastChat.botId}`;
  return firstThreadRoute(seed?.bots ?? [], seed?.groups ?? []);
}

/**
 * Opens a chat in any of the user's spaces. A known destination can show its authorized
 * navigation immediately while the model gate checks its scope.
 */
export function useOpenSpaceChat({
  bootstrapSpaceId,
  userId,
  navigate,
  navigationRevision,
  overlayRevision,
  closeMobileSidebar,
  knownSpaces,
  backgroundTarget,
}: {
  bootstrapSpaceId: string | undefined;
  userId: string | undefined;
  navigate: ReturnType<typeof useShellNavigation>["navigate"];
  navigationRevision: ReturnType<typeof useShellNavigation>["navigationRevision"];
  overlayRevision: ReturnType<typeof useShellNavigation>["overlayRevision"];
  closeMobileSidebar: () => void;
  knownSpaces?: readonly WorkspaceNavigationSpace[];
  backgroundTarget?: { spaceId: string; path: string };
}) {
  const spaceSwitchRequest = useRef(0);
  const preloaded = useRef<{
    userId: string;
    spaceId: string;
    botId: string | undefined;
    startedAt: number;
    controller: AbortController;
    promise: Promise<AppBootstrap>;
  } | null>(null);
  const [pendingSpace, setPendingSpace] = useState<{
    id: string;
    request: number;
    navigation: number;
    index: unknown;
  } | null>(null);
  // Navigation refs change before this shell renders, including same-path navigation.
  useEffect(() => {
    if (
      pendingSpace &&
      (pendingSpace.request !== spaceSwitchRequest.current ||
        pendingSpace.navigation !== navigationRevision.current ||
        pendingSpace.index !== window.history.state?.idx)
    )
      setPendingSpace(null);
  });
  useEffect(() => {
    const onPopState = () => {
      spaceSwitchRequest.current += 1;
      setPendingSpace(null);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      // A switch still loading when this shell goes away (another page, or a
      // newer switch) must not pull the user back to its space afterwards.
      spaceSwitchRequest.current += 1;
      preloaded.current?.controller.abort();
      preloaded.current = null;
      window.removeEventListener("popstate", onPopState);
    };
  }, []);
  const preloadSpaceChat = useCallback(
    (spaceId: string, path: string, priority?: RequestInit["priority"]) => {
      if (
        !userId ||
        spaceId === (selectedSpaceId() ?? bootstrapSpaceId) ||
        getCallSnapshot() ||
        queryClient.getQueryData(spaceSeedKey(userId, spaceId))
      )
        return;
      const target = initialBootstrapTarget(path, false);
      if (!target) return;
      const current = preloaded.current;
      if (
        current?.userId === userId &&
        current.spaceId === spaceId &&
        current.botId === target.botId &&
        Date.now() - current.startedAt < PRELOAD_MAX_AGE_MS
      )
        return;
      current?.controller.abort();
      const controller = new AbortController();
      const promise = preloadSpaceBootstrap(spaceId, target.botId, controller.signal, priority);
      preloaded.current = {
        userId,
        spaceId,
        botId: target.botId,
        startedAt: Date.now(),
        controller,
        promise,
      };
      void promise.catch(() => {
        if (preloaded.current?.promise === promise) preloaded.current = null;
      });
    },
    [bootstrapSpaceId, userId],
  );
  const { spaceId: backgroundSpaceId, path: backgroundPath } = backgroundTarget ?? {};
  useEffect(() => {
    if (!backgroundSpaceId || !backgroundPath || !userId) return;
    const request = spaceSwitchRequest.current;
    const timer = window.setTimeout(() => {
      // Let the current chat load first. A hover or switch takes priority over this guess.
      if (
        document.visibilityState !== "hidden" &&
        !preloaded.current &&
        spaceSwitchRequest.current === request
      )
        preloadSpaceChat(backgroundSpaceId, backgroundPath, "low");
    }, BACKGROUND_PRELOAD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [backgroundPath, backgroundSpaceId, preloadSpaceChat, userId]);

  const openSpaceChat = useCallback(
    (spaceId: string, path: string) => {
      closeMobileSidebar();
      const request = ++spaceSwitchRequest.current;
      setPendingSpace(null);
      const startedNavigation = navigationRevision.current;
      const startedOverlay = overlayRevision.current;
      const startedIndex = window.history.state?.idx;
      const previousEffective = selectedSpaceId() ?? bootstrapSpaceId;
      // Persist the active space (including primary) so voice/RPC headers match the chat.
      if (previousEffective === spaceId) {
        if (selectSpace(spaceId, bootstrapSpaceId)) navigate(path);
        return;
      }
      const reload = () => {
        void leaveOrganization(userId ?? null, previousEffective, spaceId).then(() => {
          if (request !== spaceSwitchRequest.current) return;
          if (selectSpace(spaceId)) window.location.assign(destination());
        });
      };
      const destination = () =>
        overlayRevision.current === startedOverlay
          ? path
          : `${path}${searchString(withShellOverlay(new URLSearchParams(), readShellOverlay(new URLSearchParams(window.location.search))))}`;
      // Each space gets its own bootstrap and shell. A call in progress, or a page
      // outside the shell, still reloads.
      const target = initialBootstrapTarget(path, false);
      if (!target || getCallSnapshot()) {
        reload();
        return;
      }
      const startedAt = window.location.pathname;
      const decision = () =>
        spaceSwitchDecision(
          request === spaceSwitchRequest.current &&
            startedNavigation === navigationRevision.current &&
            startedIndex === window.history.state?.idx,
          startedAt,
          window.location.pathname,
          Boolean(getCallSnapshot()),
        );
      const current = () => decision() !== "abandon";
      // A space visited before opens at once with what it showed then, refreshing behind it.
      const settlePending = () => {
        if (request === spaceSwitchRequest.current) {
          setPendingSpace((current) => (current?.request === request ? null : current));
        }
      };
      const cached = queryClient.getQueryData(spaceSeedKey(userId ?? null, spaceId));
      const preload = preloaded.current;
      preloaded.current = null;
      const matchingPreload =
        !cached &&
        preload &&
        preload.userId === userId &&
        preload.spaceId === spaceId &&
        preload.botId === target.botId &&
        Date.now() - preload.startedAt < PRELOAD_MAX_AGE_MS;
      if (!matchingPreload) preload?.controller.abort();
      const preview =
        userId && knownSpaces?.some((space) => space.id === spaceId)
          ? { userId, spaces: knownSpaces }
          : undefined;
      const primed = primeSpaceBootstrap(
        spaceId,
        target.botId,
        cached,
        matchingPreload ? preload.promise : undefined,
        preview,
      );
      const remount = () =>
        remountShellForSpace(() => {
          const action = decision();
          settlePending();
          if (action !== "commit") {
            discardPrimedBootstrap(primed);
            if (action === "reload") reload();
            return false;
          }
          if (!selectSpace(spaceId)) {
            discardPrimedBootstrap(primed);
            return false;
          }
          void leaveOrganization(userId ?? null, previousEffective, spaceId);
          // Playback belongs to the conversation being left.
          speaker.stop();
          navigate(destination());
          return true;
        });
      if (cached || preview) {
        remount();
        return;
      }
      setPendingSpace({ id: spaceId, request, navigation: startedNavigation, index: startedIndex });
      primed.then(
        () => {
          if (!current()) {
            settlePending();
            discardPrimedBootstrap(primed);
            return;
          }
          // A call started while the bootstrap loaded belongs to this space.
          if (getCallSnapshot()) {
            settlePending();
            discardPrimedBootstrap(primed);
            reload();
            return;
          }
          remount();
        },
        () => {
          settlePending();
          discardPrimedBootstrap(primed);
          if (current()) reload();
        },
      );
    },
    [bootstrapSpaceId, knownSpaces, navigate, navigationRevision, overlayRevision, userId],
  );
  return { openSpaceChat, preloadSpaceChat, pendingSpaceId: pendingSpace?.id ?? null };
}
