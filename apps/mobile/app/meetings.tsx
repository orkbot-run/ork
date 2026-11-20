// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { MeetingDetail, MeetingSummary } from "@orkbot/contracts";
import { parseMeetingLink } from "@orkbot/contracts";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Alert, AppState, ScrollView, Text, TextInput, View } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSwitch } from "../components/native-switch";
import { selectedSpaceId } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { captureSettingsContext } from "../lib/settings-target";
import { errorText } from "../lib/user-error";

const active = (meeting: MeetingSummary) =>
  ["scheduled", "joining", "recording", "processing"].includes(meeting.status);
const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
export default function MeetingsScreen() {
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const spaceId = selectedSpaceId();
  const context = useMemo(
    () => captureSettingsContext(spaceId ? { scope: "space", spaceId } : { scope: "account" }),
    [spaceId, botId],
  );
  const [status, setStatus] = useState<{
    enabled: boolean;
    dailyLimit: number;
    maxMinutes: number;
  } | null>(null);
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [schedule, setSchedule] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const availability = await context.send("meetings/status");
      if (!context.isCurrent()) return;
      setStatus(availability);
      if (!availability.enabled) return;
      const [rows, meeting] = await Promise.all([
        context.send("meetings/list", { botId }),
        selected ? context.send("meetings/get", { meetingId: selected }) : Promise.resolve(null),
      ]);
      if (context.isCurrent()) {
        setMeetings(rows);
        setDetail(meeting);
        setError(null);
      }
    } catch (cause) {
      if (context.isCurrent()) setError(errorText(cause));
    }
  }, [botId, selected, context]);
  const hasActive = meetings.some(active);
  useFocusEffect(
    useCallback(() => {
      let pending = false;
      const update = async () => {
        if (pending || AppState.currentState !== "active") return;
        pending = true;
        try {
          await refresh();
        } finally {
          pending = false;
        }
      };
      void update();
      const timer = hasActive ? setInterval(() => void update(), 15000) : undefined;
      return () => {
        if (timer) clearInterval(timer);
      };
    }, [refresh, hasActive]),
  );
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      if (context.isCurrent()) await refresh();
    } catch (cause) {
      if (context.isCurrent()) setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  const text = { color: tokens.foreground, fontSize: 16, lineHeight: 24 };
  const field = {
    color: tokens.foreground,
    backgroundColor: tokens.card,
    borderColor: tokens.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    minHeight: 48,
  };
  const statusText = (value: string) =>
    t(
      (
        {
          scheduled: "Scheduled",
          joining: "Joining",
          recording: "Recording",
          processing: "Processing",
          completed: "Completed",
          failed: "Failed",
          canceled: "Canceled",
        } as Record<string, string>
      )[value] ?? value,
    );
  return (
    <>
      <Stack.Screen options={glassHeaderOptions(t("Meetings"))} />
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24, gap: 16 }}
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        {error ? (
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {error}
          </Text>
        ) : null}
        <NativeActionButton
          label={t("Refresh")}
          prominence="quiet"
          disabled={busy}
          onPress={() => void refresh()}
        />
        {!status ? (
          <Text style={text}>{t("Loading…")}</Text>
        ) : !status.enabled ? (
          <Text style={text}>{t("Meetings are not available on this server.")}</Text>
        ) : selected ? (
          <>
            <NativeActionButton
              label={t("Back to meetings")}
              prominence="quiet"
              onPress={() => {
                setSelected(null);
                setDetail(null);
              }}
            />
            {!detail ? (
              <Text style={text}>{t("Loading…")}</Text>
            ) : (
              <>
                <Text style={[text, { fontSize: 22, fontWeight: "600" }]}>{detail.title}</Text>
                <Text style={text}>{statusText(detail.status)}</Text>
                {detail.error ? (
                  <Text style={{ color: tokens.destructive }}>{detail.error}</Text>
                ) : null}
                {["scheduled", "joining", "recording"].includes(detail.status) ? (
                  <NativeActionButton
                    label={t(detail.status === "scheduled" ? "Cancel meeting" : "Stop and leave")}
                    busy={busy}
                    onPress={() =>
                      void run(() => context.send("meetings/leave", { meetingId: detail.id }))
                    }
                  />
                ) : null}
                {!active(detail) ? (
                  <NativeActionButton
                    label={t("Delete meeting")}
                    prominence="destructive"
                    disabled={busy}
                    onPress={() =>
                      Alert.alert(
                        t("Delete meeting"),
                        t("Delete this meeting and its transcript? This cannot be undone."),
                        [
                          { text: t("Keep meeting"), style: "cancel" },
                          {
                            text: t("Confirm deletion"),
                            style: "destructive",
                            onPress: () =>
                              void run(async () => {
                                await context.send("meetings/remove", { meetingId: detail.id });
                                setSelected(null);
                                setDetail(null);
                              }),
                          },
                        ],
                      )
                    }
                  />
                ) : null}
                <Text style={[text, { fontWeight: "600" }]}>{t("Transcript")}</Text>
                {detail.transcript.length ? (
                  detail.transcript.map((segment, index) => (
                    <View key={`${segment.startMs}-${index}`} style={{ gap: 4 }}>
                      <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
                        {segment.speaker} · {time(segment.startMs)}–{time(segment.endMs)}
                      </Text>
                      <Text selectable style={text}>
                        {segment.text}
                      </Text>
                    </View>
                  ))
                ) : (
                  <Text style={text}>
                    {t("No transcript yet. It will appear after processing.")}
                  </Text>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <Text style={[text, { fontSize: 22, fontWeight: "600" }]}>
              {t("Invite your bot to a meeting")}
            </Text>
            <Text style={text}>
              {t(
                "The bot joins visibly, records audio and creates a transcript. Inform every participant before inviting it.",
              )}
            </Text>
            <Text style={text}>{t("Meeting link")}</Text>
            <TextInput
              accessibilityLabel={t("Meeting link")}
              value={url}
              onChangeText={setUrl}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              style={field}
            />
            <Text style={{ color: tokens.mutedForeground }}>
              {t("Google Meet, Zoom and Microsoft Teams links are supported.")}
            </Text>
            <Text style={text}>{t("Title (optional)")}</Text>
            <TextInput
              accessibilityLabel={t("Title (optional)")}
              value={title}
              onChangeText={setTitle}
              maxLength={200}
              style={field}
            />
            <Text style={text}>{t("Schedule (optional)")}</Text>
            <TextInput
              accessibilityLabel={t("Schedule (optional)")}
              value={schedule}
              onChangeText={setSchedule}
              placeholder="2026-12-01T10:00"
              placeholderTextColor={tokens.mutedForeground}
              autoCapitalize="none"
              style={field}
            />
            <Text style={{ color: tokens.mutedForeground }}>
              {t("Leave empty to join now. Scheduled time uses your device time zone.")}
            </Text>
            <Text style={[text, { fontWeight: "600" }]}>{t("Invite your bot to a meeting")}</Text>
            <Text style={text}>
              {t(
                "The bot joins visibly, records audio and creates a transcript. Inform every participant before inviting it.",
              )}
            </Text>
            <Text style={text}>{t("Meeting link")}</Text>
            <TextInput
              accessibilityLabel={t("Meeting link")}
              style={field}
              value={url}
              onChangeText={setUrl}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={4096}
            />
            <Text style={{ color: tokens.mutedForeground }}>
              {t("Google Meet, Zoom and Microsoft Teams links are supported.")}
            </Text>
            <Text style={text}>{t("Title (optional)")}</Text>
            <TextInput
              accessibilityLabel={t("Title (optional)")}
              style={field}
              value={title}
              onChangeText={setTitle}
              maxLength={120}
            />
            <Text style={text}>{t("Schedule (optional)")}</Text>
            <TextInput
              accessibilityLabel={t("Schedule (optional)")}
              style={field}
              value={schedule}
              onChangeText={setSchedule}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="YYYY-MM-DDTHH:mm"
              placeholderTextColor={tokens.mutedForeground}
            />
            <Text style={{ color: tokens.mutedForeground }}>
              {t("Leave empty to join now. Scheduled time uses your device time zone.")}
            </Text>
            <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
              <Text style={[text, { flex: 1 }]}>
                {t(
                  "I have informed all participants and have permission to record and transcribe this meeting.",
                )}
              </Text>
              <NativeSwitch
                accessibilityLabel={t(
                  "I have informed all participants and have permission to record and transcribe this meeting.",
                )}
                value={consent}
                onValueChange={setConsent}
              />
            </View>
            <Text style={{ color: tokens.mutedForeground }}>
              {t("Daily limit: {dailyLimit}. Maximum meeting length: {maxMinutes} minutes.", {
                dailyLimit: status.dailyLimit,
                maxMinutes: status.maxMinutes,
              })}
            </Text>
            <NativeActionButton
              label={t(schedule ? "Schedule meeting" : "Join meeting")}
              busy={busy}
              onPress={() => {
                if (!parseMeetingLink(url)) {
                  setError(
                    t("Enter a supported Google Meet, Zoom or Microsoft Teams meeting link."),
                  );
                  return;
                }
                if (!consent) {
                  setError(
                    t("Confirm that all participants have been informed before continuing."),
                  );
                  return;
                }
                const date = schedule ? new Date(schedule) : null;
                if (
                  date &&
                  (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(schedule) ||
                    !Number.isFinite(date.getTime()) ||
                    date.getTime() <= Date.now())
                ) {
                  setError(t("Enter a future date and time in YYYY-MM-DDTHH:mm format."));
                  return;
                }
                void run(async () => {
                  const created = await context.send("meetings/create", {
                    botId,
                    url: url.trim(),
                    title: title.trim() || undefined,
                    scheduledAt: date?.toISOString(),
                    confirmed: true,
                  });
                  if (context.isCurrent()) {
                    setSelected(created.id);
                    setConsent(false);
                    setUrl("");
                    setTitle("");
                    setSchedule("");
                  }
                });
              }}
            />
            <Text style={[text, { fontWeight: "600" }]}>{t("Meetings")}</Text>
            {meetings.length ? (
              meetings.map((meeting) => (
                <View
                  key={meeting.id}
                  style={{
                    borderTopWidth: 1,
                    borderTopColor: tokens.border,
                    paddingTop: 12,
                    gap: 4,
                  }}
                >
                  <NativeActionButton
                    label={meeting.title}
                    prominence="quiet"
                    onPress={() => setSelected(meeting.id)}
                  />
                  <Text style={{ color: tokens.mutedForeground }}>
                    {statusText(meeting.status)} ·{" "}
                    {new Date(meeting.scheduledAt ?? meeting.createdAt).toLocaleString()}
                  </Text>
                </View>
              ))
            ) : (
              <Text style={text}>{t("No meetings yet.")}</Text>
            )}
          </>
        )}
      </ScrollView>
    </>
  );
}
