// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 badges and photo rendering are preserved. Ork-only avatars follow LICENSE.md.

import type { BotAvatarSet } from "@orkbot/contracts";
import { parseBotAvatarValue } from "@orkbot/contracts";
import type { AvatarMotionMode, LogoAvatarActivity } from "@orkbot/core";
import { avatarWorkingDot, botAvatarActivity, isPersonalOrkId, isRunWorking } from "@orkbot/core";
import { memo, useSyncExternalStore } from "react";
import { Image, View } from "react-native";
import { mobileBotAvatarPresentation } from "../lib/bot-avatar";
import { useI18n } from "../lib/i18n";
import { mobileLogoAvatarActivity } from "../lib/logo-avatar-activity";
import { useMobileTokens } from "../lib/native";
import { LogoAvatar } from "./logo-avatar";
import { NativeSymbol } from "./native-symbol";

export interface BotAvatarProps {
  color: string;
  size?: number;
  status?: string;
  identity?: string;
  avatarSeed?: string | null;
  avatarSet?: BotAvatarSet;
  activity?: LogoAvatarActivity;
  muted?: boolean;
  motion?: AvatarMotionMode;
  composing?: boolean;
  pokeable?: boolean;
}

export const BotAvatar = memo(function BotAvatar(props: BotAvatarProps) {
  const parsed = mobileBotAvatarPresentation(props.color);
  if (parsed.kind === "image") return <PhotoBotAvatar {...props} imageUrl={parsed.imageUrl} />;
  return (
    <OrkBotAvatar
      {...props}
      avatarSeed={parseBotAvatarValue(props.color).kind === "shape" ? undefined : props.avatarSeed}
      color={parsed.kind === "color" ? parsed.color : props.color}
    />
  );
});

function OrkBotAvatar({
  color,
  identity,
  avatarSeed,
  size = 54,
  status,
  activity,
  composing = false,
  muted = false,
  motion = "static",
  pokeable = false,
}: BotAvatarProps) {
  const liveActivity = useSyncExternalStore(
    mobileLogoAvatarActivity.subscribe,
    () => mobileLogoAvatarActivity.getActivity(identity ?? "", status),
    (): LogoAvatarActivity => "idle",
  );
  const resolved = botAvatarActivity(
    { color, avatarSet: "orkbot" },
    activity ??
      (composing && (liveActivity === "working" || liveActivity === "idle")
        ? "writing"
        : liveActivity),
  );
  const working = isRunWorking(status) && resolved !== "writing" && motion !== "running";
  return (
    <View style={{ width: size, height: size }}>
      <LogoAvatar
        color={color}
        identity={isPersonalOrkId(avatarSeed) ? avatarSeed : identity}
        size={size}
        activity={resolved}
        motion={motion}
        pokeable={pokeable}
      />
      {working ? <WorkingDot size={size} muted={muted} /> : null}
      {muted ? <MutedBadge size={size} /> : null}
    </View>
  );
}

function WorkingDot({ size, muted }: { size: number; muted: boolean }) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const dot = avatarWorkingDot(size);
  return (
    <View
      accessibilityLabel={t("Working")}
      style={{
        position: "absolute",
        right: muted ? undefined : dot.inset - dot.ring,
        left: muted ? dot.inset - dot.ring : undefined,
        bottom: dot.inset - dot.ring,
        width: dot.diameter + dot.ring * 2,
        height: dot.diameter + dot.ring * 2,
        borderRadius: size,
        borderWidth: dot.ring,
        borderColor: tokens.background,
        backgroundColor: tokens.workingDot,
      }}
    />
  );
}

function MutedBadge({ size }: { size: number }) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  return (
    <View
      accessible
      accessibilityLabel={t("Notifications silenced")}
      style={{
        position: "absolute",
        right: -2,
        bottom: -2,
        width: Math.max(14, Math.round(size * 0.34)),
        height: Math.max(14, Math.round(size * 0.34)),
        borderRadius: size,
        borderWidth: 2,
        borderColor: tokens.background,
        // Opaque under the translucent fill, so the avatar does not show through the bell.
        backgroundColor: tokens.background,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          borderRadius: size,
          backgroundColor: tokens.secondary,
        }}
      />
      <NativeSymbol
        ios="bell.slash.fill"
        android="notifications-off"
        size={Math.max(8, Math.round(size * 0.17))}
        color={tokens.foreground}
      />
    </View>
  );
}

function PhotoBotAvatar({
  imageUrl,
  size = 54,
  status,
  composing = false,
  muted = false,
  motion = "static",
}: BotAvatarProps & { imageUrl: string }) {
  const tokens = useMobileTokens();
  const working = isRunWorking(status) && !composing && motion !== "running";
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          overflow: "hidden",
          backgroundColor: tokens.secondary,
        }}
      >
        <Image source={{ uri: imageUrl }} style={{ width: size, height: size }} />
      </View>
      {working ? <WorkingDot size={size} muted={muted} /> : null}
      {muted ? <MutedBadge size={size} /> : null}
    </View>
  );
}
