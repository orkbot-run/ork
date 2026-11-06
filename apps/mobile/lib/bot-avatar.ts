// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 value parsing is preserved. Ork-only presentation follows LICENSE.md.

import type { ParsedBotAvatar } from "@orkbot/contracts";
import { parseBotAvatarValue } from "@orkbot/contracts";
import { resolvePersonaColorDef } from "@orkbot/core";

export type MobileBotAvatarPresentation = Exclude<ParsedBotAvatar, { kind: "shape" }>;

/** Saved shape suffixes retain their colour; every non-photo uses the Ork renderer. */
export function mobileBotAvatarPresentation(color: string): MobileBotAvatarPresentation {
  const parsed = parseBotAvatarValue(color);
  if (parsed.kind === "color" || parsed.kind === "shape") {
    return { kind: "color", color: resolvePersonaColorDef("preview", parsed.color).hex };
  }
  return parsed;
}
