// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useIsFocused } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useAppForeground } from "../../lib/app-foreground";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";

export function ThreadMessagesSkeleton() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  const pulse = useAnimatedStyle(() => ({ opacity: opacity.value }));

  useEffect(() => {
    if (!focused || !foreground || reducedMotion) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(withTiming(0.6, { duration: 1100 }), -1, true);
    return () => cancelAnimation(opacity);
  }, [focused, foreground, reducedMotion, opacity]);

  const fill = { backgroundColor: tokens.border };
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("Loading…")}
      accessibilityState={{ busy: true }}
      pointerEvents="none"
      style={styles.container}
    >
      <Animated.View
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.messages, pulse]}
      >
        <View style={[styles.outgoing, styles.shortBubble, { backgroundColor: tokens.muted }]}>
          <View style={[styles.line, styles.mediumLine, fill]} />
        </View>
        <View style={styles.incoming}>
          <View style={[styles.avatar, fill]} />
          <View style={styles.paragraph}>
            <View style={[styles.line, styles.longLine, fill]} />
            <View style={[styles.line, styles.fullLine, fill]} />
            <View style={[styles.line, styles.shortLine, fill]} />
          </View>
        </View>
        <View style={[styles.outgoing, styles.longBubble, { backgroundColor: tokens.muted }]}>
          <View style={[styles.line, styles.longLine, fill]} />
          <View style={[styles.line, styles.mediumLine, fill]} />
        </View>
        <View style={styles.incoming}>
          <View style={[styles.avatar, fill]} />
          <View style={styles.paragraph}>
            <View style={[styles.line, styles.fullLine, fill]} />
            <View style={[styles.line, styles.mediumLine, fill]} />
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 0, overflow: "hidden", justifyContent: "flex-end" },
  messages: { flexShrink: 0, gap: 28, paddingBottom: 8 },
  outgoing: { alignSelf: "flex-end", borderRadius: 20, padding: 16, gap: 10 },
  shortBubble: { width: "48%", maxWidth: 260 },
  longBubble: { width: "68%", maxWidth: 380 },
  incoming: { flexDirection: "row", alignItems: "flex-start", gap: 12, maxWidth: 500 },
  avatar: { width: 28, height: 28, borderRadius: 14, flexShrink: 0 },
  paragraph: { flex: 1, minWidth: 0, gap: 10, paddingTop: 6 },
  line: { height: 10, borderRadius: 5 },
  fullLine: { width: "96%" },
  longLine: { width: "88%" },
  mediumLine: { width: "72%" },
  shortLine: { width: "46%" },
});
