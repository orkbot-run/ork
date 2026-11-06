// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 photo and colour editing is preserved. Obsolete shape editing was removed.

import { BOT_COLORS, parseBotAvatarValue } from "@orkbot/contracts";

/** The color a bot avatar value is drawn in; a photo falls back to the first palette color. */
export function avatarColor(value: string): string {
  const parsed = parseBotAvatarValue(value);
  return parsed.kind === "color" || parsed.kind === "shape" ? parsed.color : BOT_COLORS[0];
}

export function isAvatarPhoto(value: string): boolean {
  return parseBotAvatarValue(value).kind === "image";
}

/** A new colour replaces a photo or obsolete shape marker. */
export function withAvatarColor(_value: string, color: string): string {
  return color;
}
