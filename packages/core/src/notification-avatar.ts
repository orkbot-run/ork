// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to use shared studio features in notification portraits.
// Inherited identity and avatar selection remain Apache-2.0. New changes follow LICENSE.md.

import { serializeParts } from "@orkbot/avatar/art";
import { BotAvatarValueSchema, parseBotAvatarValue } from "@orkbot/contracts";
import { lightTokens } from "@orkbot/ui-tokens";
import { resolvePersonaColorDef } from "./bot-avatar-colors.js";
import {
  LOGO_AVATAR_ART_TRANSFORM,
  LOGO_AVATAR_BODY_Y,
  LOGO_AVATAR_VIEWBOX,
  logoAvatarEyeInk,
  ORK_AVATAR_BODY_PATHS,
  ORK_AVATAR_SATELLITES,
  orkAvatarAccessoryParts,
  orkAvatarCheekParts,
  orkAvatarEyeParts,
  orkAvatarMouthParts,
} from "./logo-avatar-art.js";
import { logoAvatarTraits } from "./logo-avatar-traits.js";
import { isPersonalOrkId } from "./personal-ork.js";

/** A static notification portrait, with the same identity, saved photo and silhouette as chat. */
export function notificationAvatarSource(bot: {
  id: string;
  color: string;
  avatarSet?: string | null;
  avatarSeed?: string | null;
}): string {
  const parsed = BotAvatarValueSchema.safeParse(bot.color).success
    ? parseBotAvatarValue(bot.color)
    : null;
  if (parsed?.kind === "image") return parsed.imageUrl;
  const identity =
    isPersonalOrkId(bot.avatarSeed) && parsed?.kind !== "shape" ? bot.avatarSeed : bot.id;
  const color = resolvePersonaColorDef(
    identity,
    parsed && "color" in parsed ? parsed.color : bot.color,
  ).hex;
  // The push is flattened onto white, so the face uses ink for a light page.
  const { color: fill, appearance } = logoAvatarTraits(identity, color);
  const viewBox = LOGO_AVATAR_VIEWBOX;
  const ink = logoAvatarEyeInk(fill, lightTokens);
  const parts = [
    ...ORK_AVATAR_SATELLITES.slice(0, appearance.satellites).map(([cx, cy, r]) => ({
      tag: "circle" as const,
      props: { cx, cy, r, fill },
    })),
    ...orkAvatarAccessoryParts(appearance.accessory, "behind"),
    { tag: "path" as const, props: { d: ORK_AVATAR_BODY_PATHS[appearance.shape], fill } },
    ...(appearance.cheeks ? orkAvatarCheekParts() : []),
    ...([0, 1] as const).flatMap((index) =>
      orkAvatarEyeParts(appearance.eyes, appearance.eyeSize, index, ink),
    ),
    ...orkAvatarMouthParts(appearance.mouth, ink),
    ...orkAvatarAccessoryParts(appearance.accessory, "front"),
  ];
  const body = `<g transform="translate(0 ${LOGO_AVATAR_BODY_Y})"><g transform="${LOGO_AVATAR_ART_TRANSFORM}">${serializeParts(parts)}</g></g>`;
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="${viewBox}">${body}</svg>`)}`;
}
