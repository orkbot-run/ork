// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { useOutgoingDraft } from "@orkbot/chat-ui/outgoing-draft";
import type { ThreadMessage } from "@orkbot/contracts";
import { approvalReasonText } from "@orkbot/core";
import { typeScale } from "@orkbot/ui-tokens";
import { useRef } from "react";
import { Text, TextInput, View } from "react-native";
import { plainAskTitle } from "../../lib/ask-title";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { NativeActionButton } from "../native-action-button";

type Ask = Extract<ThreadMessage["blocks"][number], { kind: "ask" }>;
export function OutgoingDraftCard({
  ask,
  canAnswer,
  onAnswer,
}: {
  ask: Ask;
  canAnswer: boolean;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const draft = ask.outgoingDraft!;
  const state = useOutgoingDraft(draft, onAnswer);
  const recipient = useRef<TextInput>(null);
  const body = useRef<TextInput>(null);
  const answered = ask.status === "answered" || Boolean(state.accepted);
  const fields = ask.status === "answered" ? draft : state.fields;
  const editable = canAnswer && !answered && !state.pending && !state.awaitingReview;
  const error =
    state.error === "recipient"
      ? t("Enter a recipient")
      : state.error === "body"
        ? t("Enter a message body")
        : state.error
          ? t("Could not submit this answer")
          : undefined;
  const fieldStyle = {
    borderWidth: 1,
    borderColor: tokens.border,
    color: tokens.foreground,
    borderRadius: 12,
    padding: 12,
    minHeight: 48,
    fontSize: 16,
  };
  return (
    <View
      testID="outgoing-draft-card"
      style={{
        width: "100%",
        borderRadius: 18,
        padding: 16,
        gap: 12,
        backgroundColor: tokens.card,
      }}
    >
      <Text style={{ color: tokens.foreground, ...typeScale.cardTitle }}>
        {plainAskTitle(ask.text)}
      </Text>
      {ask.approvalReason ? (
        <Text style={{ color: tokens.mutedForeground, ...typeScale.secondary }}>
          {t(approvalReasonText(ask.approvalReason))}
        </Text>
      ) : null}
      {ask.detail ? (
        <Text style={{ color: tokens.mutedForeground, ...typeScale.secondary }}>{ask.detail}</Text>
      ) : null}
      {draft.recipientChanged || state.awaitingReview ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: tokens.mutedForeground, ...typeScale.secondary }}
        >
          {t("Recipient changed. Review the updated draft and press Send again.")}
        </Text>
      ) : null}
      <View style={{ gap: 4 }}>
        <Text style={{ color: tokens.foreground, ...typeScale.secondary }}>{t("To")}</Text>
        <TextInput
          ref={recipient}
          accessibilityLabel={t("To")}
          value={fields.recipient}
          editable={editable}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(value) => state.edit("recipient", value)}
          style={fieldStyle}
        />
      </View>
      {draft.kind === "email" ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: tokens.foreground, ...typeScale.secondary }}>{t("Subject")}</Text>
          <TextInput
            accessibilityLabel={t("Subject")}
            value={fields.subject ?? ""}
            editable={editable}
            onChangeText={(value) => state.edit("subject", value)}
            style={fieldStyle}
          />
        </View>
      ) : null}
      <View style={{ gap: 4 }}>
        <Text style={{ color: tokens.foreground, ...typeScale.secondary }}>
          {t("Message body")}
        </Text>
        <TextInput
          ref={body}
          accessibilityLabel={t("Message body")}
          value={fields.body}
          editable={editable}
          multiline
          textAlignVertical="top"
          onChangeText={(value) => state.edit("body", value)}
          style={[fieldStyle, { minHeight: 160 }]}
        />
      </View>
      {error ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ color: tokens.destructive, ...typeScale.secondary }}
        >
          {error}
        </Text>
      ) : null}
      {answered ? (
        <Text style={{ color: tokens.mutedForeground, ...typeScale.secondary }}>
          {t(
            (ask.status === "answered" ? ask.answer : state.accepted) === "deny"
              ? "Denied"
              : "Approved to send",
          )}
        </Text>
      ) : !canAnswer ? (
        <Text style={{ color: tokens.mutedForeground }}>{t("No longer active")}</Text>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <NativeActionButton
            label={t("Send")}
            disabled={!editable}
            busy={state.pending}
            onPress={() => {
              if (!fields.recipient.trim()) recipient.current?.focus();
              else if (!fields.body.trim()) body.current?.focus();
              void state.submit();
            }}
          />
          <NativeActionButton
            label={t("Reject")}
            prominence="secondary"
            disabled={!editable}
            onPress={() => void state.submit(true)}
          />
        </View>
      )}
    </View>
  );
}
