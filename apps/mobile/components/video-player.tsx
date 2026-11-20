import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { StyleSheet, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

/** A local video file played with the system's controls, full screen included. */
export default function VideoPlayer({ uri, name }: { uri: string; name: string }) {
  const player = useVideoPlayer(uri);
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const { status } = useEvent(player, "statusChange", { status: player.status });
  if (status === "error") {
    return (
      <View style={styles.centered}>
        <Text style={styles.notice}>{t("No preview for this file type.")}</Text>
      </View>
    );
  }
  return (
    <VideoView
      accessibilityLabel={name}
      player={player}
      nativeControls
      contentFit="contain"
      style={styles.fill}
    />
  );
}

function createStyles() {
  return StyleSheet.create({
    fill: { flex: 1 },
    centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
    notice: { color: native.secondaryLabel, fontSize: 14, textAlign: "center" },
  });
}
