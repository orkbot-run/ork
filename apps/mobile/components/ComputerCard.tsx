// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 card behavior is preserved. Takeover previews and replies follow LICENSE.md.

import { ChatMarkdown } from "@orkbot/chat-ui/native";
import type { ComputerFrame, ComputerReleaseReason, MessageBlock } from "@orkbot/contracts";
import { typeScale } from "@orkbot/ui-tokens";
import { useIsFocused } from "expo-router";
import { useEffect, useState } from "react";
import type { ViewProps } from "react-native";
import { Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { captureApiRequestContext, rpc } from "../lib/api";
import { useAppForeground } from "../lib/app-foreground";
import { useI18n } from "../lib/i18n";
import { threadCardWidth } from "../lib/message-presentation";
import { native, useMobileTokens, useResolvedAppearance } from "../lib/native";
import { useThreadReadOnly } from "../lib/thread-read-only";
import { NativeActionButton } from "./native-action-button";

const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  card: {
    borderRadius: 18,
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  header: { flexDirection: "row", gap: 8, justifyContent: "space-between" },
  preview: { width: "100%", height: 160, borderRadius: 8, borderWidth: 1 },
  state: { flexShrink: 1, ...typeScale.caption },
  title: typeScale.cardTitle,
});

function requestError(error: unknown) {
  if (typeof error !== "object" || error === null || !("status" in error)) return "failed";
  if (error.status === 409) return "closed";
  if (error.status === 403 || error.status === 404) return "forbidden";
  return "failed";
}

export function ComputerCard({
  block,
  botId,
  runId,
  messageId,
  onOpen,
  accessibilityActions,
  onAccessibilityAction,
}: {
  block: Extract<MessageBlock, { kind: "computer" }>;
  botId?: string;
  runId?: string;
  messageId: string;
  onOpen?: (showScreen: boolean) => void;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const readOnly = useThreadReadOnly();
  const foreground = useAppForeground();
  const focused = useIsFocused();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { width: windowWidth } = useWindowDimensions();
  const [resolved, setResolved] = useState<ComputerReleaseReason>();
  const [expanded, setExpanded] = useState(false);
  const [frame, setFrame] = useState<ComputerFrame | null>();
  const [previewIssue, setPreviewIssue] = useState<"closed" | "forbidden">();
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<ReturnType<typeof requestError>>();
  const state = resolved === "done" ? "Done" : resolved === "skipped" ? "Skipped" : block.state;
  const waiting = state === "Needs you";
  const settled = state === "Done" || state === "Skipped";
  const previewActive =
    waiting &&
    !readOnly &&
    focused &&
    foreground &&
    actionError !== "closed" &&
    actionError !== "forbidden";
  const issue = previewIssue ?? actionError;
  const closed = issue === "closed" || issue === "forbidden";

  useEffect(() => {
    setFrame(undefined);
    if (!previewActive || !botId || !runId) return;
    const controller = new AbortController();
    const { signal } = controller;
    void captureApiRequestContext()
      .then((requestContext) =>
        rpc("computer/takeoverPreview", { botId, runId, messageId }, { signal, requestContext }),
      )
      .then((result) => {
        if (signal.aborted) return;
        setFrame(result);
        setPreviewIssue(undefined);
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        const issue = requestError(error);
        if (issue !== "failed") setPreviewIssue(issue);
        setFrame(null);
      });
    return () => controller.abort();
  }, [botId, runId, messageId, previewActive]);

  async function respond(reason?: ComputerReleaseReason) {
    if (!botId || !waiting || readOnly || closed || pending) return;
    if (!runId) {
      onOpen?.(false);
      return;
    }
    setPending(true);
    setActionError(undefined);
    try {
      const requestContext = await captureApiRequestContext();
      if (reason) {
        const result = await rpc(
          "computer/release",
          { botId, runId, messageId, reason },
          { requestContext },
        );
        if (!result.resolved) {
          setActionError("failed");
          return;
        }
        setResolved(reason);
      } else {
        await rpc("computer/takeover", { botId, runId, messageId }, { requestContext });
        onOpen?.(true);
      }
    } catch (error) {
      setActionError(requestError(error));
    } finally {
      setPending(false);
    }
  }

  const label = t(state);
  const header = (
    <View style={styles.header}>
      <Text
        accessibilityActions={!settled ? accessibilityActions : undefined}
        onAccessibilityAction={!settled ? onAccessibilityAction : undefined}
        style={[styles.title, { color: tokens.foreground }]}
      >
        {t("Computer")}
      </Text>
      <Text
        style={[
          styles.state,
          {
            color: waiting
              ? tokens.warning
              : state === "Skipped"
                ? tokens.mutedForeground
                : tokens.success,
          },
        ]}
      >
        {label}
      </Text>
    </View>
  );

  return (
    <View
      testID="computer-card"
      style={[
        styles.card,
        {
          width: threadCardWidth(windowWidth),
          backgroundColor: native.fill,
        },
      ]}
    >
      {!settled ? (
        header
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t("Computer")}, ${label}`}
          accessibilityState={{ expanded }}
          accessibilityActions={accessibilityActions}
          onAccessibilityAction={onAccessibilityAction}
          onPress={() => setExpanded((value) => !value)}
        >
          {header}
        </Pressable>
      )}
      {block.text && (!settled || expanded) ? (
        <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
          {block.text}
        </ChatMarkdown>
      ) : null}
      {previewActive &&
        botId &&
        runId &&
        !closed &&
        (frame ? (
          <Image
            accessible
            accessibilityLabel={t("Computer screen preview")}
            resizeMode="contain"
            style={[styles.preview, { borderColor: tokens.border }]}
            source={{ uri: `data:${frame.mimeType};base64,${frame.data}` }}
          />
        ) : (
          <Text accessibilityLiveRegion="polite" style={{ color: tokens.mutedForeground }}>
            {frame === undefined ? t("Loading preview…") : t("Computer screen preview unavailable")}
          </Text>
        ))}
      {waiting && issue && (
        <Text accessibilityRole="alert" style={{ color: tokens.mutedForeground }}>
          {issue === "closed"
            ? t("This computer request is no longer waiting")
            : issue === "forbidden"
              ? t("You do not have access to this computer request")
              : t("Could not continue")}
        </Text>
      )}
      {!settled && botId && !readOnly && !(waiting && closed) ? (
        <View style={styles.actions}>
          {waiting && runId && (
            <>
              <NativeActionButton
                label={t("Skip")}
                prominence="secondary"
                fill={false}
                disabled={pending}
                onPress={() => void respond("skipped")}
              />
              <NativeActionButton
                label={t("Done")}
                prominence="secondary"
                fill={false}
                disabled={pending}
                onPress={() => void respond("done")}
              />
            </>
          )}
          {onOpen && (
            <View testID="computer-card-open">
              <NativeActionButton
                label={waiting ? t("Take control") : t("Open computer")}
                fill={false}
                disabled={pending}
                onPress={() => (waiting ? void respond() : onOpen(false))}
              />
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}
