// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to verify the new shared body and smile.
// Inherited avatar behavior checks remain Apache-2.0. New changes follow LICENSE.md.

import {
  BOT_COLOR_LIST,
  contrastRatio,
  logoAvatarEyeInk,
  logoAvatarTraits,
  ORK_AVATAR_BODY_PATHS,
  orkAvatarAccessoryParts,
  orkAvatarEyeParts,
  orkAvatarMouthParts,
  seededLogoAvatarColor,
} from "@orkbot/core";
import { tokens } from "@orkbot/ui-tokens";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotAvatar } from "./bot-avatar.js";
import { LogoAvatar } from "./logo-avatar.js";

describe("logo-derived avatar prototype", () => {
  it("uses the shared identity colour during SSR when no saved choice is supplied", () => {
    for (const identity of ["seed-bot-1", "seed-bot-2"]) {
      const expected = seededLogoAvatarColor(identity);
      expect(renderToString(<LogoAvatar identity={identity} />)).toContain(
        `data-color="${expected}"`,
      );
      expect(
        renderToString(<BotAvatar color="" identity={identity} avatarSet="orkbot" />),
      ).toContain(`data-color="${expected}"`);
    }
  });
  it("renders studio artwork as vectors with an accessible name", () => {
    const html = renderToString(<LogoAvatar activity="reading" label="Inbox is reading" />);
    expect(html).toContain('data-vector-body="true"');
    expect(html).not.toContain("<image");
    expect(html).not.toContain("<filter");
    const { appearance } = logoAvatarTraits("default");
    expect(html).toContain(`d="${ORK_AVATAR_BODY_PATHS[appearance.shape]}"`);
    expect(html).toContain('class="logo-avatar-smile"');
    expect(html).not.toContain("<mask");
    expect(html).not.toContain("orange-bot.png");
    expect(html).toContain("logo-avatar-gaze");
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Inbox is reading"');
  });

  it("renders different studio bodies, eyes, mouths and accessories for saved bot identities", () => {
    const bodies = new Set<string>();
    const faces = new Set<string>();
    for (let index = 0; index < 64; index++) {
      const identity = `bot-${index}`;
      const appearance = logoAvatarTraits(identity).appearance;
      const html = renderToString(
        <LogoAvatar identity={identity} avatarValue="#123456" motion={false} />,
      );
      const ink = logoAvatarEyeInk("#123456", tokens);
      const path = ORK_AVATAR_BODY_PATHS[appearance.shape];
      expect(html).toContain(`d="${path}"`);
      const parts = [
        ...orkAvatarEyeParts(appearance.eyes, appearance.eyeSize, 0, ink),
        ...orkAvatarEyeParts(appearance.eyes, appearance.eyeSize, 1, ink),
        ...orkAvatarMouthParts(appearance.mouth, ink),
        ...orkAvatarAccessoryParts(appearance.accessory, "behind"),
        ...orkAvatarAccessoryParts(appearance.accessory, "front"),
      ];
      for (const part of parts)
        expect(html).toContain(renderToString(createElement(part.tag, part.props)));
      bodies.add(path);
      faces.add(JSON.stringify({ path, parts }));
    }
    expect(bodies.size).toBe(8);
    expect(faces.size).toBe(64);
  });

  it("gives repeated avatars unique local clip and gradient references", () => {
    const html = renderToString(
      <>
        <LogoAvatar />
        <LogoAvatar />
      </>,
    );
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(4);
  });

  it.each([16, 20])("keeps %spx avatars still", (size) => {
    const html = renderToString(<LogoAvatar activity="writing" size={size} />);
    expect(html).toContain('data-motion="false"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("leaves an uploaded avatar intact", () => {
    const html = renderToString(<BotAvatar color="data:image/png;base64,abc" avatarSet="orkbot" />);
    expect(html).toContain('src="data:image/png;base64,abc"');
    expect(html).not.toContain("bot-avatar-body.png");
  });

  it("replaces legacy selected shapes with generator artwork", () => {
    const html = renderToString(<BotAvatar color="#8B5CF6::shape_3" avatarSet="orkbot" />);
    expect(html).not.toContain("bot-character-eyes");
    expect(html).toContain("orkbot-logo-avatar");
    expect(html).not.toContain("bot-avatar-body.png");
  });

  it("does not load arbitrary avatar URLs", () => {
    const html = renderToString(<LogoAvatar avatarValue="https://example.test/track.png" />);
    expect(html).not.toContain("example.test");
    expect(html).toContain('data-vector-body="true"');
    expect(html).not.toContain("<image");
  });

  it("retains a supplied body colour and uses light eyes on a dark body", () => {
    const html = renderToString(<LogoAvatar identity="dark-bot" avatarValue="#101014" />);
    expect(html).toContain('data-color="#101014"');
    const eyeInk = logoAvatarEyeInk("#101014", tokens);
    expect(contrastRatio("#101014", eyeInk)).toBeGreaterThanOrEqual(3);
    const appearance = logoAvatarTraits("dark-bot").appearance;
    for (const part of orkAvatarEyeParts(appearance.eyes, appearance.eyeSize, 0, eyeInk)) {
      expect(html).toContain(renderToString(createElement(part.tag, part.props)));
    }
    expect(html).toContain("radialGradient");
    expect(html).not.toContain("feColorMatrix");
  });

  it.each(BOT_COLOR_LIST)("keeps $name eyes legible", ({ hex }) => {
    const html = renderToString(<LogoAvatar identity="contrast-sample" avatarValue={hex} />);
    const eyeInk = logoAvatarEyeInk(hex, tokens);
    expect(contrastRatio(hex, eyeInk)).toBeGreaterThanOrEqual(3);
    const appearance = logoAvatarTraits("contrast-sample").appearance;
    for (const part of [
      ...orkAvatarEyeParts(appearance.eyes, appearance.eyeSize, 0, eyeInk),
      ...orkAvatarMouthParts(appearance.mouth, eyeInk),
    ]) {
      expect(html).toContain(renderToString(createElement(part.tag, part.props)));
    }
  });
});
