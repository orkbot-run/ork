// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to verify notification portraits retain the shared Ork face.
// Inherited avatar compatibility checks remain Apache-2.0. New changes follow LICENSE.md.

import {
  contrastRatio,
  logoAvatarEyeInk,
  logoAvatarTraits,
  notificationAvatarSource,
  ORK_AVATAR_BODY_PATHS,
  orkAvatarEyeParts,
  orkAvatarMouthParts,
} from "@orkbot/core";
import { lightTokens } from "@orkbot/ui-tokens";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { BotAvatar } from "./bot-avatar.js";

type Attributes = Record<string, string>;

function tags(svg: string, name: string): Attributes[] {
  return Array.from(svg.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "g")), (tag) =>
    Object.fromEntries(
      Array.from(tag[1]!.matchAll(/([\w-]+)="([^"]*)"/g), (attribute) => [
        attribute[1]!,
        attribute[2]!,
      ]),
    ),
  );
}

it.each<[string, { color: string; avatarSet?: "orkbot" }]>([
  ["organic", { color: "#14b8a6" }],
  ["shipped shape", { color: "#8B5CF6::shape_3" }],
  ["orkbot", { color: "#14b8a6", avatarSet: "orkbot" }],
])("draws the %s notification portrait from the chat avatar's geometry", (_, avatar) => {
  const bot = { id: "agent-1", ...avatar };
  const source = notificationAvatarSource(bot);
  const portrait = decodeURIComponent(source.slice(source.indexOf(",") + 1));
  const chat = renderToString(
    <BotAvatar color={bot.color} identity={bot.id} avatarSet={bot.avatarSet} activity="idle" />,
  );

  const [svg] = tags(portrait, "svg");
  expect(tags(chat, "svg")).toContainEqual(expect.objectContaining({ viewBox: svg!.viewBox }));
  {
    const { appearance, color } = logoAvatarTraits(bot.id, bot.color);
    const body = tags(portrait, "path").find(
      (part) => part.d === ORK_AVATAR_BODY_PATHS[appearance.shape],
    )!;
    expect(tags(chat, "path")).toContainEqual(expect.objectContaining({ d: body.d }));
    expect(chat).toContain(`data-color="${body.fill}"`);
    const ink = logoAvatarEyeInk(color, lightTokens);
    expect(contrastRatio(body.fill!, ink)).toBeGreaterThanOrEqual(3);
    for (const part of [
      ...orkAvatarEyeParts(appearance.eyes, appearance.eyeSize, 0, ink),
      ...orkAvatarEyeParts(appearance.eyes, appearance.eyeSize, 1, ink),
      ...orkAvatarMouthParts(appearance.mouth, ink),
    ]) {
      const attributes = Object.fromEntries(
        Object.entries(part.props).map(([key, value]) => [
          key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
          String(value),
        ]),
      );
      expect(tags(portrait, part.tag)).toContainEqual(expect.objectContaining(attributes));
      expect(tags(chat, part.tag)).toContainEqual(expect.objectContaining(attributes));
    }
  }
  for (const transform of tags(portrait, "g").flatMap((group) => group.transform ?? [])) {
    expect(chat).toContain(`transform="${transform}"`);
  }
});
