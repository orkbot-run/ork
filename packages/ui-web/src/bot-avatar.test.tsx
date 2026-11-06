// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Inherited image and color checks remain Apache-2.0. Generator-only checks follow LICENSE.md.

import { ACTIVE_RUN_STATUSES, logoAvatarTraits, ORK_AVATAR_BODY_PATHS } from "@orkbot/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BOT_AVATAR_COLORS,
  BotAvatar,
  BotShapePreview,
  DEFAULT_BOT_AVATAR_COLOR,
  defaultBotAvatarValue,
  parseBotAvatar,
  resolvePersonaColorDef,
} from "./bot-avatar.js";

describe("BotAvatar", () => {
  it.each([undefined, "organic", "orkbot"] as const)(
    "renders only generator icons for stored set %s",
    (avatarSet) => {
      const appearance = logoAvatarTraits("saved-bot").appearance;
      for (const color of ["#123456", "#123456::shape_3"]) {
        const html = renderToString(
          <BotAvatar identity="saved-bot" color={color} avatarSet={avatarSet} />,
        );
        expect(html).toContain("orkbot-logo-avatar");
        expect(html).toContain(`d="${ORK_AVATAR_BODY_PATHS[appearance.shape]}"`);
        expect(html).toContain('data-color="#123456"');
        expect(html).not.toMatch(/orkbot-organic-avatar|bot-character-eyes/);
      }
    },
  );

  it("keeps instance references unique for the same bot rendered twice", () => {
    const html = renderToString(
      <>
        <BotAvatar color="#123456" identity="same-bot" />
        <BotAvatar color="#123456" identity="same-bot" />
      </>,
    );
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("previews generator artwork with the picker label and selected state", () => {
    const html = renderToString(
      <BotShapePreview identity="preview-bot" label="Shape 1" color="#123456" selected />,
    );
    expect(html).toContain('aria-label="Shape 1"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("orkbot-logo-avatar");
    expect(html).not.toContain("orkbot-organic-avatar");
  });

  it("strips a legacy shape suffix when restoring the default look", () => {
    expect(defaultBotAvatarValue("#123456::shape_3")).toBe("#123456");
    expect(defaultBotAvatarValue("#abc::shape_2")).toBe("#abc");
    expect(defaultBotAvatarValue("data:image/png;base64,abc")).toBe(DEFAULT_BOT_AVATAR_COLOR);
    expect(defaultBotAvatarValue("#zzzzzz::shape_1")).toBe(DEFAULT_BOT_AVATAR_COLOR);
  });

  // Button sizes any SVG without a size class, which beats width/height attributes but not inline styles.

  it.each([...ACTIVE_RUN_STATUSES])("marks active run status %s as working", (status) => {
    const html = renderToString(<BotAvatar color="#3B82F6" status={status} />);
    expect(html).toContain("<svg");
    expect(html).toContain('data-working="true"');
  });

  it("keeps working attribute false when idle", () => {
    const html = renderToString(<BotAvatar color="#F59E0B" status="idle" />);
    expect(html).toContain('data-working="false"');
  });

  it("renders distinct shapes for distinct bot identities", () => {
    const maya = renderToString(<BotAvatar color={DEFAULT_BOT_AVATAR_COLOR} identity="maya" />);
    const github = renderToString(<BotAvatar color={DEFAULT_BOT_AVATAR_COLOR} identity="github" />);
    expect(maya).not.toEqual(github);
  });

  it("parses shape indexes from encoded color values", () => {
    const parsed = parseBotAvatar(`${DEFAULT_BOT_AVATAR_COLOR}::shape_3`);
    expect(parsed.color).toBe(DEFAULT_BOT_AVATAR_COLOR);
    expect(parsed.shapeIndex).toBe(3);
    expect(parsed.isImage).toBe(false);
  });

  it("normalizes malformed shape suffixes to shape 0", () => {
    expect(parseBotAvatar(`${DEFAULT_BOT_AVATAR_COLOR}::shape_-1`).shapeIndex).toBe(0);
    expect(parseBotAvatar(`${DEFAULT_BOT_AVATAR_COLOR}::shape_3junk`).shapeIndex).toBe(0);
    expect(parseBotAvatar(`${DEFAULT_BOT_AVATAR_COLOR}::shape_`).shapeIndex).toBe(0);
  });

  it("resolves explicit colors and shapes", () => {
    expect(resolvePersonaColorDef("bot", "#10B981").hex).toBe("#00C972");
    expect(resolvePersonaColorDef("bot", "#fff").hex).toBe("#fff");
    expect(BOT_AVATAR_COLORS.length).toBeGreaterThan(0);
  });

  it("falls back to the identity palette for invalid custom hex", () => {
    expect(resolvePersonaColorDef("bot", "#zzzzzz")).toEqual(resolvePersonaColorDef("bot"));
    expect(resolvePersonaColorDef("bot", "#ggg")).toEqual(resolvePersonaColorDef("bot"));
  });

  it("renders uploaded images without the geometric svg", () => {
    const html = renderToString(
      <BotAvatar color="data:image/png;base64,abc" identity="maya" size={32} />,
    );
    expect(html).toContain("<img");
    expect(html).not.toContain("<path");
    expect(html).not.toContain("bot-character-eyes");
  });

  it("keeps a working photo ring outside the clipped image and uses the status token", () => {
    const html = renderToString(
      <BotAvatar color="data:image/png;base64,abc" identity="maya" size={32} status="running" />,
    );
    expect(html).toContain('class="orkbot-bot-avatar relative shrink-0 select-none"');
    expect(html).toContain("orkbot-bot-avatar-picture");
    expect(html).toContain("orkbot-bot-avatar-ring-working");
    expect(html).toContain("stroke-status-working");
    expect(html).toContain('data-working="true"');
    expect(html.indexOf("orkbot-bot-avatar-picture")).toBeLessThan(
      html.indexOf("orkbot-bot-avatar-ring"),
    );
  });

  it("keeps idle photo avatars ring-free", () => {
    const html = renderToString(
      <BotAvatar color="data:image/png;base64,abc" identity="maya" size={32} status="idle" />,
    );
    expect(html).toContain("orkbot-bot-avatar-picture");
    expect(html).toContain('data-working="false"');
    expect(html).not.toContain("orkbot-bot-avatar-ring");
  });

  it("does not treat arbitrary http(s) color values as remote images", () => {
    const parsed = parseBotAvatar("https://evil.example/track.png");
    expect(parsed.isImage).toBe(false);
    expect(parsed.imageUrl).toBeUndefined();
    const html = renderToString(
      <BotAvatar color="https://evil.example/track.png" identity="maya" size={32} />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.example");
  });

  it("keeps uploaded images", () => {
    const html = renderToString(<BotAvatar color="data:image/png;base64,abc" identity="maya" />);
    expect(html).toContain("<img");
    expect(html).not.toContain("orkbot-organic-avatar");
  });
});
