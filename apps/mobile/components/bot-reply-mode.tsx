// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Bot, BotReplyMode } from "@orkbot/contracts";
import { createQueuedSave } from "@orkbot/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { currentApiBase, selectedSpaceId, spaceSelectionSeq } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import {
  currentReadySessionGeneration,
  currentSessionGeneration,
  registerSessionDiskCache,
  subscribeSessionGeneration,
} from "../lib/session";
import { captureSettingsContext } from "../lib/settings-target";
import { errorText } from "../lib/user-error";
import { MenuPicker } from "./menu-picker";

type ReplyBot = Pick<Bot, "id" | "spaceId" | "replyMode" | "updatedAt">;
type Origin = ReturnType<typeof captureSettingsContext>;

/** Captured operations can finish after closing; only a verified rotation may renew their owner. */
export function BotReplyModeSetting({
  bot,
  registerFlush,
  onSavingChange,
}: {
  bot: ReplyBot;
  registerFlush?: (flush: (() => Promise<void>) | undefined) => void;
  onSavingChange?: (saving: boolean) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const live = useRef(false);
  const retired = useRef(false);
  const eligibleRotation = useRef<number | undefined>(undefined);
  const owner = useRef(bot);
  owner.current = bot;
  const [saving, setSaving] = useState(false);
  const acceptedVersion = useRef(bot.updatedAt);
  const [value, setValue] = useState<BotReplyMode>(bot.replyMode ?? "chat");
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const baseOrigin = useMemo(
    () => captureSettingsContext({ scope: "space", spaceId: bot.spaceId }),
    [bot.id, bot.spaceId],
  );
  const routing = useMemo(
    () => ({ apiBase: currentApiBase(), space: selectedSpaceId(), selection: spaceSelectionSeq() }),
    [baseOrigin],
  );
  const [rotation, setRotation] = useState<{ base: Origin; origin: Origin; bot: ReplyBot }>();
  const rebound = rotation?.base === baseOrigin ? rotation : undefined;
  const origin = rebound?.origin ?? baseOrigin;
  const snapshot = rebound?.bot ?? bot;
  const readyGeneration = useSyncExternalStore(
    subscribeSessionGeneration,
    currentReadySessionGeneration,
  );
  const sameRoute = () =>
    routing.apiBase === currentApiBase() &&
    routing.space === selectedSpaceId() &&
    routing.selection === spaceSelectionSeq();
  const sameBot = () => owner.current.id === bot.id && owner.current.spaceId === bot.spaceId;
  const owned = () => !retired.current && origin.isCurrent() && sameBot();
  const current = () => live.current && owned();
  useLayoutEffect(() => {
    live.current = true;
    acceptedVersion.current = snapshot.updatedAt;
    setValue(snapshot.replyMode ?? "chat");
    setError(null);
    setSaving(false);
    onSavingChange?.(false);
    return () => {
      live.current = false;
    };
  }, [origin]);
  useLayoutEffect(
    () =>
      registerSessionDiskCache((sameAccount) => {
        if (!sameAccount || !sameRoute() || !sameBot()) {
          retired.current = true;
          eligibleRotation.current = undefined;
        } else if (!retired.current) eligibleRotation.current = currentSessionGeneration();
      }),
    [baseOrigin],
  );
  const queue = useMemo(
    () =>
      createQueuedSave<BotReplyMode>(snapshot.replyMode ?? "chat", {
        save: async (replyMode) => {
          if (!owned()) throw new Error("Session changed");
          const next = await origin.send("bots/update", { botId: bot.id, replyMode });
          if (!owned()) throw new Error("Session changed");
          if (next.replyMode !== replyMode) throw new Error(t("Could not save bot"));
          if (next.updatedAt > acceptedVersion.current) acceptedVersion.current = next.updatedAt;
        },
        onChange: (next) => {
          if (current()) {
            setValue(next);
            setError(null);
          }
        },
        onError: (failure) => {
          if (current()) setError(errorText(failure, t("Could not save bot")));
        },
        onSavingChange: (pending) => {
          if (current()) {
            setSaving(pending);
            onSavingChange?.(pending);
          }
        },
      }),
    [origin, bot.id],
  );
  useLayoutEffect(() => {
    registerFlush?.(queue.flush);
    return () => registerFlush?.(undefined);
  }, [queue, registerFlush]);
  useEffect(() => {
    if (
      retired.current ||
      eligibleRotation.current !== readyGeneration ||
      !sameRoute() ||
      !sameBot()
    )
      return;
    let active = true;
    const fresh = captureSettingsContext({ scope: "space", spaceId: bot.spaceId });
    void (async () => {
      // Resolve accepted old requests before reading their authoritative result with the new bearer.
      await queue.flush().catch(() => undefined);
      if (!active || retired.current || !sameRoute() || !sameBot() || !fresh.isCurrent()) return;
      const next = await fresh.send("bots/get", { botId: bot.id });
      if (
        !active ||
        !live.current ||
        retired.current ||
        !sameRoute() ||
        !sameBot() ||
        !fresh.isCurrent()
      )
        return;
      if (next.id !== bot.id || next.spaceId !== bot.spaceId) return;
      eligibleRotation.current = undefined;
      if (next.replyMode === undefined) {
        setUnsupported(true);
        setSaving(false);
        onSavingChange?.(false);
        registerFlush?.(undefined);
        return;
      }
      setUnsupported(false);
      setRotation({ base: baseOrigin, origin: fresh, bot: next });
    })().catch((failure: unknown) => {
      if (
        active &&
        live.current &&
        !retired.current &&
        sameRoute() &&
        sameBot() &&
        fresh.isCurrent()
      )
        setError(errorText(failure, t("Could not load bot")));
    });
    return () => {
      active = false;
    };
  }, [readyGeneration, baseOrigin, bot.updatedAt]);
  useEffect(() => {
    if (!saving && current() && bot.updatedAt > acceptedVersion.current) {
      acceptedVersion.current = bot.updatedAt;
      queue.reset(bot.replyMode ?? "chat");
      setValue(bot.replyMode ?? "chat");
    }
  }, [bot.replyMode, bot.updatedAt, queue, saving]);
  if (unsupported) return null;
  return (
    <View>
      <MenuPicker
        label={t("Reply mode")}
        value={value}
        choices={[
          { key: "chat", label: t("Chat") },
          { key: "explicit", label: t("Updates and final reply") },
        ]}
        onChange={(next) => {
          if (current() && (next === "chat" || next === "explicit")) queue.update(next);
        }}
      />
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
