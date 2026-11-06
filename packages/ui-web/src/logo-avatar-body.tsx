// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to replace the inherited body artwork with Ork clay art.
// Inherited renderer structure remains Apache-2.0. New changes follow LICENSE.md.

import type { LogoAvatarTraits, OrkAvatarPart } from "@orkbot/core";
import {
  LOGO_AVATAR_ART_TRANSFORM,
  LOGO_AVATAR_LIGHTING as lighting,
  logoAvatarPaint,
  ORK_AVATAR_BODY_PATHS,
  ORK_AVATAR_SATELLITES,
  orkAvatarAccessoryParts,
  orkAvatarCheekParts,
} from "@orkbot/core";
import { createElement, memo } from "react";

export function LogoAvatarParts({ parts }: { parts: readonly OrkAvatarPart[] }) {
  return parts.map((part, index) => createElement(part.tag, { ...part.props, key: index }));
}

/** Shared vector contour with a soft clay finish. */
export const LogoAvatarBody = memo(function LogoAvatarBody({
  id,
  color,
  appearance,
}: {
  id: string;
  color: string;
  appearance: LogoAvatarTraits["appearance"];
}) {
  const paint = logoAvatarPaint(color);
  const path = ORK_AVATAR_BODY_PATHS[appearance.shape];
  return (
    <g className="logo-avatar-art" transform={LOGO_AVATAR_ART_TRANSFORM}>
      <defs>
        <clipPath id={`body-clip-${id}`}>
          <path d={path} />
        </clipPath>
        <linearGradient id={`body-fill-${id}`} {...lighting.body}>
          <stop stopColor={paint.light} />
          <stop offset=".53" stopColor={paint.base} />
          <stop offset="1" stopColor={paint.shadow} />
        </linearGradient>
        <radialGradient
          id={`body-light-${id}`}
          cx={lighting.crown.cx}
          cy={lighting.crown.cy}
          r={lighting.crown.r}
        >
          <stop stopColor="white" stopOpacity={lighting.crown.peak} />
          <stop offset=".4" stopColor="white" stopOpacity={lighting.crown.shoulder} />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`body-satellite-${id}`} {...lighting.satellite}>
          <stop stopColor={paint.light} />
          <stop offset="1" stopColor={paint.base} />
        </radialGradient>
      </defs>
      {ORK_AVATAR_SATELLITES.slice(0, appearance.satellites).map(([cx, cy, r], index) => (
        <g key={index}>
          <circle cx={cx} cy={cy} r={r} fill={`url(#body-satellite-${id})`} />
          <circle
            cx={cx - r * 0.26}
            cy={cy - r * 0.34}
            r={r * 0.22}
            fill="white"
            fillOpacity={0.27}
          />
        </g>
      ))}
      <LogoAvatarParts parts={orkAvatarAccessoryParts(appearance.accessory, "behind")} />
      <path d={path} fill={`url(#body-fill-${id})`} />
      <path d={path} fill={`url(#body-light-${id})`} />
      {appearance.shine ? (
        <g clipPath={`url(#body-clip-${id})`}>
          <path
            d={lighting.shine.path}
            fill="none"
            stroke="white"
            strokeOpacity={lighting.shine.opacity}
            strokeWidth={lighting.shine.width}
            strokeLinecap="round"
          />
        </g>
      ) : null}
      {appearance.cheeks ? <LogoAvatarParts parts={orkAvatarCheekParts()} /> : null}
    </g>
  );
});
