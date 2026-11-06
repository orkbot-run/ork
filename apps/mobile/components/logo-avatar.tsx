// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to render the shared Ork body and face on native.
// Inherited motion and interaction handling remain Apache-2.0. New changes follow LICENSE.md.

import type { AvatarMotionMode, AvatarPoke, LogoAvatarActivity, OrkAvatarPart } from "@orkbot/core";
import {
  avatarPokeFrame,
  LOGO_AVATAR_ART_SCALE,
  LOGO_AVATAR_ART_TRANSFORM,
  LOGO_AVATAR_BODY_Y,
  LOGO_AVATAR_VIEWBOX,
  LOGO_AVATAR_LIGHTING as lighting,
  logoAvatarEyeInk,
  logoAvatarFrame,
  logoAvatarPaint,
  logoAvatarTraits,
  ORK_AVATAR_BODY_PATHS,
  ORK_AVATAR_SATELLITES,
  orkAvatarAccessoryParts,
  orkAvatarCheekParts,
  orkAvatarEyeParts,
  orkAvatarMouthParts,
} from "@orkbot/core";
import type { ReactNode } from "react";
import { useEffect, useId, useMemo } from "react";
import { Pressable } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
} from "react-native-reanimated";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";
import { useAvatarOnScreen, usePoke } from "../lib/avatar-life";
import { useLogoAvatarClock } from "../lib/logo-avatar-clock";
import { useMobileTokens } from "../lib/native";

const AnimatedG = Animated.createAnimatedComponent(G);
const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedRect = Animated.createAnimatedComponent(Rect);

/** Native SVG renderer: paths/gradients only, driven by shared deterministic motion. */
export function LogoAvatar({
  color,
  identity,
  size,
  activity,
  motion,
  pokeable = false,
}: {
  color: string;
  identity?: string;
  size: number;
  activity: LogoAvatarActivity;
  motion: AvatarMotionMode;
  pokeable?: boolean;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const tokens = useMobileTokens();
  const traits = useMemo(
    () => logoAvatarTraits(identity || color || "default", color),
    [identity, color],
  );
  const paint = useMemo(() => logoAvatarPaint(traits.color), [traits.color]);
  const reduced = useReducedMotion();
  const onScreen = useAvatarOnScreen();
  const canMove = size >= 24 && motion !== "static" && (motion !== "lazy" || activity !== "idle");
  const milliseconds = useLogoAvatarClock(canMove && onScreen && !reduced);
  const frame = useDerivedValue(() =>
    logoAvatarFrame(activity, traits, milliseconds.value, reduced || !canMove),
  );
  // SVG's native host consumes six-value matrices; no JS transform extraction per frame.
  const body = useAnimatedProps(() => ({
    opacity: 1,
    matrix: [
      frame.value.bodyScale,
      0,
      0,
      frame.value.bodyScale,
      50 * (1 - frame.value.bodyScale),
      frame.value.bodyY + 84 * (1 - frame.value.bodyScale),
    ],
  }));
  const eyeInk = logoAvatarEyeInk(traits.color, tokens);
  const appearance = traits.appearance;
  const bodyPath = ORK_AVATAR_BODY_PATHS[appearance.shape];
  const eyes = useAnimatedProps(() => {
    const lid = frame.value.lid * frame.value.blink;
    return {
      opacity: 1,
      matrix: [
        1,
        0,
        0,
        lid,
        frame.value.eyeX / LOGO_AVATAR_ART_SCALE,
        302 * (1 - lid) + frame.value.eyeY / LOGO_AVATAR_ART_SCALE,
      ],
    };
  });
  const mouth = useAnimatedProps(() => ({
    opacity: 1,
    matrix: [
      1,
      0,
      0,
      1,
      frame.value.eyeX / LOGO_AVATAR_ART_SCALE,
      frame.value.eyeY / LOGO_AVATAR_ART_SCALE,
    ],
  }));
  const page = useAnimatedProps(() => ({
    opacity: 1,
    matrix: [1, 0, 0, 1, frame.value.pageX, frame.value.pageY],
  }));
  const keyLeft = useAnimatedProps(() => ({
    opacity: frame.value.keyLeft,
    matrix: [1, 0, 0, 1, 0, frame.value.keyLeftY],
  }));
  const keyRight = useAnimatedProps(() => ({
    opacity: frame.value.keyRight,
    matrix: [1, 0, 0, 1, 0, frame.value.keyRightY],
  }));
  const pointer = useAnimatedProps(() => ({
    opacity: 1,
    matrix: [1, 0, 0, 1, frame.value.pointerX, frame.value.pointerY],
  }));
  const selection = useAnimatedProps(() => ({ opacity: frame.value.selection }));
  const stroke = Math.max(2.4, 100 / Math.max(1, size));
  const compact = size <= 38;
  const artwork = (
    <Svg width={size} height={size} viewBox={LOGO_AVATAR_VIEWBOX} accessible={false}>
      <Defs>
        <ClipPath id={`plate-${id}`}>
          <Rect width={100} height={100} rx={23} />
        </ClipPath>
        <ClipPath id={`body-${id}`}>
          <Path d={bodyPath} />
        </ClipPath>
        <LinearGradient id={`fill-${id}`} {...lighting.body}>
          <Stop stopColor={paint.light} />
          <Stop offset={0.53} stopColor={paint.base} />
          <Stop offset="1" stopColor={paint.shadow} />
        </LinearGradient>
        <RadialGradient
          id={`light-${id}`}
          cx={lighting.crown.cx}
          cy={lighting.crown.cy}
          r={lighting.crown.r}
        >
          <Stop stopColor="white" stopOpacity={lighting.crown.peak} />
          <Stop offset={0.4} stopColor="white" stopOpacity={lighting.crown.shoulder} />
          <Stop offset="1" stopColor="white" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id={`satellite-${id}`} {...lighting.satellite}>
          <Stop stopColor={paint.light} />
          <Stop offset={1} stopColor={paint.base} />
        </RadialGradient>
        <ClipPath id={`pages-${id}`}>
          <Path d="M26 79Q37 75 47 80V91Q37 87 26 91ZM53 80Q63 75 74 79V91Q63 87 53 91Z" />
        </ClipPath>
        <ClipPath id={`keys-${id}`}>
          <Rect x={26} y={78} width={48} height={16} rx={1} />
        </ClipPath>
        <ClipPath id={`screen-${id}`}>
          <Rect x={25} y={74.5} width={50} height={20} rx={1} />
        </ClipPath>
      </Defs>
      <G clipPath={`url(#plate-${id})`}>
        <AnimatedG animatedProps={body}>
          <G transform={`translate(0 ${LOGO_AVATAR_BODY_Y})`}>
            <G transform={LOGO_AVATAR_ART_TRANSFORM}>
              {ORK_AVATAR_SATELLITES.slice(0, appearance.satellites).map(([cx, cy, r]) => (
                <G key={`${cx}-${cy}`}>
                  <Circle cx={cx} cy={cy} r={r} fill={`url(#satellite-${id})`} />
                  <Circle
                    cx={cx - r * 0.26}
                    cy={cy - r * 0.34}
                    r={r * 0.22}
                    fill="white"
                    fillOpacity={0.27}
                  />
                </G>
              ))}
              <AvatarParts parts={orkAvatarAccessoryParts(appearance.accessory, "behind")} />
              <Path d={bodyPath} fill={`url(#fill-${id})`} />
              <Path d={bodyPath} fill={`url(#light-${id})`} />
              {appearance.shine ? (
                <G clipPath={`url(#body-${id})`}>
                  <Path
                    d={lighting.shine.path}
                    fill="none"
                    stroke="white"
                    strokeOpacity={lighting.shine.opacity}
                    strokeWidth={lighting.shine.width}
                    strokeLinecap="round"
                  />
                </G>
              ) : null}
              {appearance.cheeks ? <AvatarParts parts={orkAvatarCheekParts()} /> : null}
              <AnimatedG id={`eyes-${id}`} animatedProps={eyes}>
                <AvatarParts
                  parts={orkAvatarEyeParts(appearance.eyes, appearance.eyeSize, 0, eyeInk)}
                />
                <AvatarParts
                  parts={orkAvatarEyeParts(appearance.eyes, appearance.eyeSize, 1, eyeInk)}
                />
              </AnimatedG>
              <AnimatedG id={`mouth-${id}`} animatedProps={mouth}>
                <AvatarParts parts={orkAvatarMouthParts(appearance.mouth, eyeInk)} />
              </AnimatedG>
              <AvatarParts parts={orkAvatarAccessoryParts(appearance.accessory, "front")} />
            </G>
          </G>
          {size >= 24 ? (
            <G
              fill="none"
              stroke={tokens.foreground}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {activity === "reading" ? (
                <>
                  <Path
                    d="M22 76Q36 71 50 77Q64 71 78 76V96Q64 91 50 97Q36 91 22 96Z"
                    fill={tokens.background}
                  />
                  <Path d="M50 77V97" />
                  <G clipPath={`url(#pages-${id})`}>
                    <Path d="M28 84H43M57 84H72" opacity=".8" />
                    {!compact ? <AnimatedPath animatedProps={page} d="M27 81.5H36" /> : null}
                  </G>
                </>
              ) : null}
              {activity === "writing" ? (
                <>
                  <Rect x={22} y={75} width={56} height={22} rx={3} fill={tokens.background} />
                  <G clipPath={`url(#keys-${id})`}>
                    <AnimatedPath animatedProps={keyLeft} d="M29 82H35M40 82H46" />
                    <AnimatedPath animatedProps={keyRight} d="M54 82H60M65 82H71" />
                    <Path d="M36 90H64" opacity=".85" />
                  </G>
                </>
              ) : null}
              {activity === "computer" ? (
                <>
                  <Rect x={22} y={72} width={56} height={24} rx={3} fill={tokens.background} />
                  {!compact ? <Path d="M47 96V98M39 98H61" /> : null}
                  <G clipPath={`url(#screen-${id})`}>
                    {!compact ? (
                      <AnimatedRect
                        animatedProps={selection}
                        x={53}
                        y={80}
                        width={16}
                        height={11}
                        rx={1}
                      />
                    ) : null}
                    <G transform="translate(31 75)">
                      <AnimatedG animatedProps={pointer}>
                        <Path
                          d="M0 0V14L3.5 10.5L8 16L11 14L7 8.5L14 7Z"
                          fill={tokens.foreground}
                          stroke="none"
                        />
                      </AnimatedG>
                    </G>
                  </G>
                </>
              ) : null}
            </G>
          ) : null}
        </AnimatedG>
      </G>
    </Svg>
  );
  return pokeable ? (
    <PokeableLogoAvatar enabled={canMove && onScreen && !reduced} size={size}>
      {artwork}
    </PokeableLogoAvatar>
  ) : (
    artwork
  );
}

const avatarPartComponents = { path: Path, ellipse: Ellipse, rect: Rect, circle: Circle };

/** Shared generator geometry only maps to this fixed set of native SVG primitives. */
function AvatarParts({ parts }: { parts: readonly OrkAvatarPart[] }) {
  return parts.map(({ tag, props }, index) => {
    const Component = avatarPartComponents[tag];
    return <Component key={index} {...props} />;
  });
}

/** Reuse the existing tap clips without allocating a second continuous clock. */
function PokeableLogoAvatar({
  enabled,
  size,
  children,
}: {
  enabled: boolean;
  size: number;
  children: ReactNode;
}) {
  const poke = useSharedValue<AvatarPoke | null>(null);
  const pokeProgress = useSharedValue(1);
  const play = usePoke({ poke, pokeProgress }, enabled);
  const style = useAnimatedStyle(() => {
    const extra = poke.value ? avatarPokeFrame(poke.value, pokeProgress.value) : null;
    return {
      transform: [
        { translateY: (extra?.translateY ?? 0) * size },
        { rotate: `${extra?.rotate ?? 0}deg` },
        { scaleY: extra?.scaleY ?? 1 },
      ],
    };
  });
  useEffect(() => {
    if (!enabled) {
      cancelAnimation(pokeProgress);
      poke.value = null;
      pokeProgress.value = 1;
    }
    return () => cancelAnimation(pokeProgress);
  }, [enabled, poke, pokeProgress]);
  // Like the original avatar, this is a visual toy rather than an accessible action.
  return (
    <Pressable accessible={false} onPress={play}>
      <Animated.View style={style}>{children}</Animated.View>
    </Pressable>
  );
}
