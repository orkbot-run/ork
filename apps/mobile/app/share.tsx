// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache share UI is preserved; verified destination admission follows LICENSE.md.

import { useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Image, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassIconButton } from "../components/glass-icon-button";
import { NativeSymbol } from "../components/native-symbol";
import { accountsVersion, subscribeAccounts } from "../lib/accounts";
import type { MobileBot } from "../lib/api";
import {
  captureApiRequestContext,
  currentApiBase,
  loadSessionToken,
  rpc,
  selectedSpaceId,
  spaceSelectionSeq,
  subscribeApiBase,
} from "../lib/api";
import { artifactCacheSession } from "../lib/artifact-cache-session";
import {
  composerDraftScope,
  composerDraftScopeKey,
  isComposerDraftScopeCurrent,
} from "../lib/composer-draft";
import { useI18n } from "../lib/i18n";
import {
  cancelIncomingShare,
  getIncomingShare,
  selectIncomingShare,
  subscribeIncomingShare,
} from "../lib/incoming-share";
import { installationRevocationScope } from "../lib/installation-transport";
import { useMobileTokens } from "../lib/native";
import {
  currentReadySessionGeneration,
  currentSessionGeneration,
  subscribeSessionGeneration,
} from "../lib/session";
import { sharePreview } from "../lib/share-preview";
import { hydrateWorkspaceDraftSession } from "../lib/workspace-draft-session";
import { HomeSession } from "./index";

export default function ShareRoute() {
  const router = useRouter();
  const navigation = useNavigation();
  const share = useSyncExternalStore(subscribeIncomingShare, getIncomingShare);
  const account = useSyncExternalStore(subscribeAccounts, accountsVersion);
  const session = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  const ready = useSyncExternalStore(subscribeSessionGeneration, currentReadySessionGeneration);
  const server = useSyncExternalStore(subscribeApiBase, currentApiBase);
  const workspace = JSON.stringify(installationRevocationScope(server) ?? null);
  const mounted = useRef(true);
  const selected = useRef(false);
  const closing = useRef(false);
  const selectionIntent = useRef(0);
  const selecting = useRef(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const close = useCallback(() => {
    closing.current = true;
    selectionIntent.current += 1;
    cancelIncomingShare();
    router.dismissTo("/");
  }, [router]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      selectionIntent.current += 1;
    };
  }, []);
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        const payload = event.data.action.payload;
        // Authentication temporarily replaces the picker; sign-in returns here with the share.
        if (payload && "name" in payload && payload.name === "sign-in") return;
        if (selected.current || closing.current) return;
        event.preventDefault();
        close();
      }),
    [navigation, close],
  );
  useEffect(() => {
    if (!share && !selected.current && !closing.current) close();
  }, [share, close]);

  const open = useCallback(
    (bot: Pick<MobileBot, "id" | "name" | "spaceId">) => {
      // The callback owns the displayed picker, never a newer global account or incoming share.
      const waiting = share;
      if (!mounted.current || !waiting || selecting.current || closing.current) return;
      const intent = ++selectionIntent.current;
      const space = selectedSpaceId();
      const spaceVersion = spaceSelectionSeq();
      const current = () =>
        mounted.current &&
        intent === selectionIntent.current &&
        !closing.current &&
        ready === session &&
        ready === currentReadySessionGeneration() &&
        session === currentSessionGeneration() &&
        session === currentReadySessionGeneration() &&
        account === accountsVersion() &&
        server === currentApiBase() &&
        space === selectedSpaceId() &&
        spaceVersion === spaceSelectionSeq() &&
        workspace === JSON.stringify(installationRevocationScope(server) ?? null) &&
        getIncomingShare()?.generation === waiting.generation;
      selecting.current = true;
      setSelectionError(null);
      void (async () => {
        if (!current()) return;
        const context = await captureApiRequestContext();
        if (!current()) return;
        const me = await rpc("me", undefined, {
          requestContext: context,
          skipSpaceAuthRecovery: true,
        });
        if (!current()) return;
        if (me.spaceId !== bot.spaceId) throw new Error("Share destination changed");
        const token = await loadSessionToken();
        if (!current() || !token) return;
        await artifactCacheSession(token);
        if (!current()) return;
        await hydrateWorkspaceDraftSession(current);
        if (!current()) return;
        const destination = composerDraftScope(me.userId, bot.id, undefined);
        if (!destination || !isComposerDraftScopeCurrent(destination))
          throw new Error("Share destination unavailable");
        // Mark navigation before publishing: a mounted instance of the chosen chat may claim it.
        selected.current = true;
        if (!selectIncomingShare(composerDraftScopeKey(destination), waiting.generation)) {
          selected.current = false;
          return;
        }
        navigation.dispatch({
          type: "RESET",
          payload: {
            index: 1,
            routes: [
              { name: "index" },
              { name: "thread", params: { botId: bot.id, name: bot.name } },
            ],
          },
        });
      })()
        .catch(() => {
          if (current()) setSelectionError(t("Something went wrong. Try again."));
        })
        .finally(() => {
          selecting.current = false;
        });
    },
    [navigation, t, share, account, session, ready, server, workspace],
  );
  const preview = share ? sharePreview(share) : null;

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: tokens.background,
        paddingTop: insets.top + 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          marginHorizontal: 16,
          marginBottom: 12,
        }}
      >
        <GlassIconButton
          testID="share-close"
          accessibilityLabel={t("Close")}
          ios="xmark"
          android="close"
          size={44}
          color={tokens.foreground}
          fallbackStyle={{ backgroundColor: tokens.muted }}
          onPress={close}
        />
        <Text
          accessibilityRole="header"
          style={{ fontSize: 20, fontWeight: "600", color: tokens.foreground }}
        >
          {t("Share to")}
        </Text>
      </View>
      {preview ? (
        <View style={{ marginHorizontal: 20, paddingBottom: 12, gap: 8 }}>
          {preview.text ? (
            <Text numberOfLines={2} style={{ fontSize: 15, color: tokens.mutedForeground }}>
              {preview.text}
            </Text>
          ) : null}
          {preview.images.length ? (
            <View style={{ flexDirection: "row", gap: 8 }}>
              {preview.images.map((file, index) => (
                <Image
                  key={`${file.uri}:${index}`}
                  source={{ uri: file.uri }}
                  style={{ width: 48, height: 48, borderRadius: 8, backgroundColor: tokens.muted }}
                />
              ))}
              {preview.extraImages ? (
                <Text style={{ alignSelf: "center", color: tokens.mutedForeground }}>
                  +{preview.extraImages}
                </Text>
              ) : null}
            </View>
          ) : null}
          {preview.fileCount ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <NativeSymbol
                ios="doc"
                android="document-outline"
                size={20}
                color={tokens.mutedForeground}
              />
              <Text
                numberOfLines={1}
                style={{ flex: 1, fontSize: 15, color: tokens.mutedForeground }}
              >
                {preview.fileName ?? t("{count} files", { count: preview.fileCount })}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {selectionError ? (
        <Text
          accessibilityRole="alert"
          style={{ color: tokens.destructive, paddingHorizontal: 16 }}
        >
          {selectionError}
        </Text>
      ) : null}
      <HomeSession onShareSelect={open} />
    </View>
  );
}
