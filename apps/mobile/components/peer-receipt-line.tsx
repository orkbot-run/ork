// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 material is preserved; grouped receipts are Ork additions.

import type { BotAvatarSet } from "@orkbot/contracts";
import { peerReceiptList, splitPeerLabel } from "@orkbot/core";
import type { PressableProps } from "react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { peerExchangeLabel, useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { BotAvatar } from "./bot-avatar";

export function PeerReceiptLine({
  peerBotId,
  peerBotName,
  color,
  avatarSet,
  count,
  direction,
  onPress,
  recipients,
  actionProps,
}: {
  peerBotId: string;
  peerBotName: string;
  color: string;
  avatarSet?: BotAvatarSet;
  count: number;
  direction: "sent" | "received";
  onPress?: () => void;
  recipients?: {
    peerBotId: string;
    peerBotName: string;
    color: string;
    avatarSet?: BotAvatarSet;
    onPress?: () => void;
  }[];
  actionProps: Pick<
    PressableProps,
    "onLongPress" | "accessibilityActions" | "onAccessibilityAction"
  >;
}) {
  const { locale } = useI18n();
  const styles = useThemedStyles(createStyles);
  if (direction === "sent" && recipients && recipients.length > 1) {
    const peers = new Map(recipients.map((recipient) => [recipient.peerBotId, recipient]));
    const parts = peerReceiptList(recipients, locale, (names) =>
      peerExchangeLabel(1, "sent", names),
    );
    return (
      <View testID="peer-receipt-line" style={[styles.line, styles.groupedLine]}>
        {parts.map((part, index) => {
          if ("text" in part)
            return (
              <Text
                key={`text-${index}`}
                {...actionProps}
                onLongPress={actionProps.onLongPress ?? undefined}
                style={styles.label}
              >
                {part.text}
              </Text>
            );
          const recipient = peers.get(part.recipient.peerBotId)!;
          return (
            <Pressable
              key={recipient.peerBotId}
              {...actionProps}
              accessible
              accessibilityRole={recipient.onPress ? "button" : undefined}
              accessibilityLabel={peerExchangeLabel(1, "sent", recipient.peerBotName)}
              onPress={recipient.onPress}
              style={({ pressed }) => [styles.recipient, { opacity: pressed ? 0.6 : 1 }]}
            >
              <BotAvatar
                avatarSet={recipient.avatarSet}
                color={recipient.color}
                identity={recipient.peerBotId}
                size={16}
              />
              <Text style={[styles.label, styles.name]}>{recipient.peerBotName}</Text>
            </Pressable>
          );
        })}
      </View>
    );
  }
  const label = peerExchangeLabel(count, direction, peerBotName);
  const parts = splitPeerLabel(label, peerBotName);
  return (
    <Pressable
      {...actionProps}
      testID="peer-receipt-line"
      accessible
      accessibilityRole={onPress ? "button" : undefined}
      disabled={!onPress}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.line, { opacity: pressed ? 0.6 : 1 }]}
    >
      {parts.before ? <Text style={styles.label}>{parts.before}</Text> : null}
      <BotAvatar avatarSet={avatarSet} color={color} identity={peerBotId} size={16} />
      {parts.name ? (
        <Text numberOfLines={1} style={[styles.label, styles.name]}>
          {parts.name}
        </Text>
      ) : null}
      {parts.after ? <Text style={styles.label}>{parts.after}</Text> : null}
    </Pressable>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    line: {
      width: "100%",
      paddingVertical: 8,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
    },
    label: { color: tokens.mutedForeground, fontSize: 13 },
    groupedLine: { flexWrap: "wrap", columnGap: 0, rowGap: 4 },
    recipient: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      maxWidth: "100%",
    },
    name: { fontWeight: "500", flexShrink: 1 },
  });
}
