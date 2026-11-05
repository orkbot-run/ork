// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to replace the inherited body artwork with Ork clay art.
// Inherited renderer structure remains Apache-2.0. New changes follow LICENSE.md.

import { LOGO_BODY_PATH, LOGO_AVATAR_LIGHTING as lighting, logoAvatarPaint } from "@orkbot/core";
import { memo } from "react";

/** Shared vector contour with a soft clay finish. */
export const LogoAvatarBody = memo(function LogoAvatarBody({
  id,
  color,
}: {
  id: string;
  color: string;
}) {
  const paint = logoAvatarPaint(color);
  return (
    <g className="logo-avatar-art">
      <defs>
        <clipPath id={`body-clip-${id}`}>
          <path d={LOGO_BODY_PATH} />
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
      </defs>
      <path d={LOGO_BODY_PATH} fill={`url(#body-fill-${id})`} />
      <path d={LOGO_BODY_PATH} fill={`url(#body-light-${id})`} />
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
    </g>
  );
});
