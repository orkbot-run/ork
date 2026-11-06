// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to render the new Ork silhouette and clay finish.
// Inherited color contrast behavior remains Apache-2.0. New changes follow LICENSE.md.

import { botEyeColor } from "@orkbot/ui-tokens";
import type { AvatarEyes } from "./avatar-shape.js";
import { contrastRatio } from "./bot-avatar-colors.js";

export type { AvatarPart as OrkAvatarPart } from "@orkbot/avatar/art";
export {
  AVATAR_BODY_PATHS as ORK_AVATAR_BODY_PATHS,
  AVATAR_SATELLITES as ORK_AVATAR_SATELLITES,
  accessoryParts as orkAvatarAccessoryParts,
  cheekParts as orkAvatarCheekParts,
  eyeParts as orkAvatarEyeParts,
  mouthParts as orkAvatarMouthParts,
} from "@orkbot/avatar/art";

export const LOGO_AVATAR_VIEWBOX = "0 0 100 100";

/** The body and face share the existing animation plate offset. */
export const LOGO_AVATAR_BODY_Y = 9;

/** Fit the studio's complete 600-unit artwork, including accessories, onto the motion plate. */
export const LOGO_AVATAR_ART_SCALE = 0.2;
export const LOGO_AVATAR_ART_TRANSFORM = "translate(-10 -17.4) scale(0.2)";

/** Oval eyes in the body's own coordinates. */
export const LOGO_AVATAR_EYES: AvatarEyes = {
  width: 6,
  height: 10.8,
  leftCx: 38.8,
  rightCx: 61.2,
  cy: 43,
};

/** Pick one face ink that contrasts with the body's shaded face area. */
export function logoAvatarEyeInk(
  bodyColor: string,
  page: { background: string; foreground: string },
): string {
  const paint = logoAvatarPaint(bodyColor);
  const score = (ink: string) =>
    Math.min(contrastRatio(paint.base, ink), contrastRatio(paint.shadow, ink));
  if (score(botEyeColor) >= 3.5) return botEyeColor;
  return [botEyeColor, page.foreground, page.background].reduce((best, ink) =>
    score(ink) > score(best) ? ink : best,
  );
}

/** Clay shading keeps every bot's saved identity color as its base. */
export function logoAvatarPaint(hex: string) {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex;
  const rgb = [1, 3, 5].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
  const mix = (target: number, amount: number) =>
    `#${rgb
      .map((value) =>
        Math.round(value + (target - value) * amount)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
  return {
    base: full.toLowerCase(),
    light: mix(255, 0.37),
    shadow: mix(0, 0.18),
  };
}

/** Shared clay finish for web SVG and react-native-svg. */
export const LOGO_AVATAR_LIGHTING = {
  body: { x1: "12%", y1: "5%", x2: "86%", y2: "100%" },
  crown: { cx: "28%", cy: "18%", r: "72%", peak: 0.2, shoulder: 0.06 },
  satellite: { cx: "28%", cy: "22%", r: "90%" },
  shine: { path: "M188 221Q211 172 259 158", width: 23, opacity: 0.4 },
} as const;
