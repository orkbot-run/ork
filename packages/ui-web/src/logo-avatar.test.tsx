// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to verify the new shared body and smile.
// Inherited avatar behavior checks remain Apache-2.0. New changes follow LICENSE.md.

import {
  BOT_COLOR_LIST,
  contrastRatio,
  LOGO_AVATAR_SMILE_PATH,
  LOGO_BODY_PATH,
  seededLogoAvatarColor,
} from "@orkbot/core";
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
  it("renders the eye-free brand body with vector eyes and an accessible name", () => {
    const html = renderToString(<LogoAvatar activity="reading" label="Inbox is reading" />);
    expect(html).toContain('data-vector-body="true"');
    expect(html).not.toContain("<image");
    expect(html).not.toContain("<filter");
    expect(html).toContain(`d="${LOGO_BODY_PATH}"`);
    expect(html).toContain(`d="${LOGO_AVATAR_SMILE_PATH}"`);
    expect(html).toContain('class="logo-avatar-smile"');
    expect(html).not.toContain("<mask");
    expect(html).not.toContain("orange-bot.png");
    expect(html).toContain("logo-avatar-gaze");
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Inbox is reading"');
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

  it("leaves a manually selected shape intact", () => {
    const html = renderToString(<BotAvatar color="#8B5CF6::shape_3" avatarSet="orkbot" />);
    expect(html).toContain("bot-character-eyes");
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
    const eyeInk = html.match(
      /<linearGradient[^>]*id="logo-eye[^>]*>[\s\S]*?stop-color="([^"]+)"/,
    )?.[1];
    expect(eyeInk).toBeDefined();
    expect(contrastRatio("#101014", eyeInk!)).toBeGreaterThanOrEqual(3);
    expect(html).toContain("radialGradient");
    expect(html).not.toContain("feColorMatrix");
  });

  it.each(BOT_COLOR_LIST)("keeps $name eyes legible", ({ hex }) => {
    const html = renderToString(<LogoAvatar identity="contrast-sample" avatarValue={hex} />);
    const eyeInk = html.match(
      /<linearGradient[^>]*id="logo-eye[^>]*>[\s\S]*?stop-color="([^"]+)"/,
    )?.[1];
    expect(eyeInk).toBeDefined();
    expect(contrastRatio(hex, eyeInk!)).toBeGreaterThanOrEqual(3);
    const smileInk = html.match(/class="logo-avatar-smile"[^>]*stroke="([^"]+)"/)?.[1];
    expect(smileInk).toBe(eyeInk);
  });
});
