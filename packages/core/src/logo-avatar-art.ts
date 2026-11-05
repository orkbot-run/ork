// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to render the new Ork silhouette and clay finish.
// Inherited color contrast behavior remains Apache-2.0. New changes follow LICENSE.md.

import { botEyeColor } from "@orkbot/ui-tokens";
import type { AvatarEyes } from "./avatar-shape.js";
import { contrastRatio } from "./bot-avatar-colors.js";

export const LOGO_AVATAR_VIEWBOX = "0 0 100 100";

/** The body and face share the existing animation plate offset. */
export const LOGO_AVATAR_BODY_Y = 9;

/** Oval eyes in the body's own coordinates. */
export const LOGO_AVATAR_EYES: AvatarEyes = {
  width: 6.45,
  height: 11.61,
  leftCx: 37.96,
  rightCx: 62.04,
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

/** Supplied Ork/Nunu contour, normalized to the shared animation plate. */
export const LOGO_BODY_PATH =
  "M33.23 1.505Q36.67-1.72 38.39 2.795L40.325 9.46Q41.185 11.825 43.98 10.965Q50 9.89 56.02 10.965Q59.03 12.04 59.89 9.46L61.825 2.795Q63.33-1.72 66.985 1.29C82.25 10.965 89.13 26.23 88.27 43C88.055 67.295 72.575 82.775 50.43 83.635C27.21 83.635 11.3 67.94 11.73 43.43C11.3 26.445 18.61 11.825 33.23 1.505Z";

export const LOGO_AVATAR_SMILE_STROKE = 2.365;

/** Native worklets move the smile with the same gaze frame as the eyes. */
export function logoAvatarSmilePath(x = 0, y = 0): string {
  "worklet";
  return `M${45.27 + x} ${55.685 + y}Q${50 + x} ${60.63 + y} ${54.73 + x} ${55.685 + y}`;
}

export const LOGO_AVATAR_SMILE_PATH = logoAvatarSmilePath();

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
  shine: { path: "M25.92 25.585Q30.865 15.05 41.185 12.04", width: 4.945, opacity: 0.4 },
} as const;
