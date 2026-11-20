import type { MessageBlock } from "@orkbot/contracts";
import { appConnectedInput, watchConnectionAuthorization } from "@orkbot/core";
import { fontWeight, typeScale } from "@orkbot/ui-tokens";
import { useEffect, useRef, useState } from "react";
import type { ViewProps } from "react-native";
import { AppState, Linking, Text, View } from "react-native";
import {
  captureApiRequestContext,
  currentApiBase,
  rpc,
  selectedSpaceId,
  subscribeConfirmedSpaceSwitch,
} from "../lib/api";
import { appConnectPresentation } from "../lib/app-connect";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { currentSessionGeneration } from "../lib/session";
import { useThreadReadOnly } from "../lib/thread-read-only";
import { errorText } from "../lib/user-error";
import { ConnectorIcon } from "./connector-icon";
import { NativeActionButton } from "./native-action-button";

export function AppConnectCard({
  botId,
  threadId,
  messageId,
  block,
  accessibilityActions,
  onAccessibilityAction,
}: {
  botId: string;
  threadId?: string;
  messageId?: string;
  block: Extract<MessageBlock, { kind: "app_connect" }>;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const readOnly = useThreadReadOnly();
  const tokens = useMobileTokens();
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [localStatus, setLocalStatus] = useState<"pending" | "connected">(block.status);
  const [error, setError] = useState<string | null>(null);
  const connectionAttempt = useRef<AbortController | null>(null);
  const status = block.status === "connected" ? "connected" : localStatus;
  const view = appConnectPresentation({ ...block, status }, busy);

  useEffect(
    () => () => {
      const active = connectionAttempt.current;
      connectionAttempt.current = null;
      active?.abort();
    },
    [],
  );
  useEffect(() => {
    if (block.status === "connected" || readOnly) connectionAttempt.current?.abort();
  }, [block.status, readOnly]);

  async function authorize() {
    if (readOnly || !threadId) return;
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    setBusy(true);
    setWaiting(false);
    setError(null);
    try {
      const requestContext = await captureApiRequestContext();
      const isCurrent = () =>
        requestContext.apiBase === currentApiBase() &&
        requestContext.sessionGeneration === currentSessionGeneration() &&
        (requestContext.headers["x-orkbot-space-id"] ?? null) === selectedSpaceId();
      const requestOptions = { signal: controller.signal, requestContext };
      if (controller.signal.aborted || !isCurrent()) return;
      const started = await rpc(
        "connections/begin",
        {
          connectorId: block.connectorId,
          provider: block.provider,
          displayName: block.name,
        },
        requestOptions,
      );
      if (controller.signal.aborted || !isCurrent()) return;
      if (started.authorizationUrl) await Linking.openURL(started.authorizationUrl);
      const result = await watchConnectionAuthorization(
        started.connectionId,
        (input) => rpc("connections/complete", input, requestOptions),
        {
          signal: controller.signal,
          isCurrent,
          subscribeToResume: (resume) => {
            const subscription = AppState.addEventListener("change", (state) => {
              if (state === "active") resume();
            });
            const stopWatchingSpace = subscribeConfirmedSpaceSwitch(() => controller.abort());
            return () => {
              subscription.remove();
              stopWatchingSpace();
            };
          },
          onWaiting: () => {
            setBusy(false);
            setWaiting(true);
          },
        },
      );
      if (controller.signal.aborted || !isCurrent() || result.status !== "connected") return;
      setLocalStatus("connected");
      await rpc(
        "onboarding/appConnected",
        appConnectedInput(botId, threadId, block, messageId),
        requestOptions,
      ).catch(() => undefined);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(errorText(reason, t("Could not authorize this app")));
      }
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        setBusy(false);
        setWaiting(false);
      }
    }
  }

  return (
    <View
      accessibilityLabel={t("{name} connection", { name: block.name })}
      style={{
        width: "100%",
        borderRadius: 18,
        backgroundColor: native.fill,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <ConnectorIcon name={block.name} logo={block.logo} size={40} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
            style={{ color: tokens.foreground, ...typeScale.cardTitle }}
          >
            {view.title}
          </Text>
          <Text style={{ color: tokens.mutedForeground, ...typeScale.secondary }} numberOfLines={1}>
            {view.description}
          </Text>
        </View>
        {view.showAuthorize && !readOnly && threadId ? (
          <NativeActionButton
            label={waiting ? t("Start over") : view.actionLabel}
            accessibilityLabel={waiting ? undefined : t("Connect {name}", { name: block.name })}
            fill={false}
            busy={busy}
            style={{ alignSelf: "center" }}
            onPress={() => void authorize()}
          />
        ) : !view.showAuthorize ? (
          <Text
            style={{ color: tokens.success, ...typeScale.secondary, fontWeight: fontWeight.medium }}
          >
            {view.actionLabel}
          </Text>
        ) : null}
      </View>
      {waiting && !view.connected && !readOnly ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: tokens.mutedForeground, ...typeScale.caption }}
        >
          {t("Waiting for authorization.")}
        </Text>
      ) : null}
      {error ? (
        <Text style={{ color: tokens.destructive, ...typeScale.caption }}>{error}</Text>
      ) : null}
    </View>
  );
}
