// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { MenuView } from "@expo/ui/community/menu";
import { serverUpdateCanApply } from "@orkbot/core";
import { ActivityIndicator, ScrollView, Text } from "react-native";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "../../components/settings-group";
import { useI18n } from "../../lib/i18n";
import { native, useMobileTokens } from "../../lib/native";
import { useServerUpdates } from "../../lib/server-updates";

export default function Updates() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { updates, state } = useServerUpdates(true);
  const status = state.status;
  if (!status?.available) return null;
  const request = status.lastRequest?.state;
  const notice =
    state.uncertain || request === "unknown"
      ? t("Could not confirm the update")
      : request === "completed"
        ? t("Server updated")
        : request === "requested"
          ? t("Deployment requested")
          : state.error || status.error
            ? t("Could not complete the update. Try again.")
            : null;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: native.groupedPage }}
      contentContainerStyle={{ padding: 20, gap: 20 }}
    >
      <SettingsGroup label={t("Server")}>
        <SettingsRow title={t("Server")} value={status.currentRevision?.slice(0, 12)} />
        {status.candidate ? <SettingsRow title={status.candidate.version} /> : null}
        {status.channelSelectable ? (
          <MenuView
            title={t("Channel")}
            actions={[
              { id: "stable", title: t("Stable") },
              { id: "preview", title: "Beta" },
            ]}
            onPressAction={(event) => {
              const channel = event.nativeEvent.event;
              if (!state.busy && (channel === "stable" || channel === "preview"))
                void updates.channel(channel);
            }}
          >
            <SettingsRow
              title={t("Channel")}
              value={status.channel === "preview" ? "Beta" : t("Stable")}
              accessibilityRole="button"
              disabled={Boolean(state.busy)}
              chevron="down"
            />
          </MenuView>
        ) : status.channel === "preview" ? (
          <SettingsRow title={t("Preview")} />
        ) : null}
        <SettingsRow
          title={t("Check for updates")}
          accessibilityRole="button"
          disabled={Boolean(state.busy)}
          onPress={() => void updates.check()}
          trailing={
            state.busy === "check" ? (
              <ActivityIndicator color={tokens.mutedForeground} />
            ) : undefined
          }
        />
        {status.candidate ? (
          <SettingsRow
            title={t("Update server")}
            accessibilityRole="button"
            disabled={!serverUpdateCanApply(state)}
            onPress={() => void updates.apply()}
            trailing={
              state.busy === "apply" ? (
                <ActivityIndicator color={tokens.mutedForeground} />
              ) : undefined
            }
          />
        ) : null}
        <SettingsSwitch
          label={t("Automatic updates")}
          value={status.mode === "automatic"}
          disabled={Boolean(state.busy)}
          onChange={(value) => void updates.policy(value)}
        />
      </SettingsGroup>
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={{ color: tokens.mutedForeground }}>
          {notice}
        </Text>
      ) : null}
    </ScrollView>
  );
}
