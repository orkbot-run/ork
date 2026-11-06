// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 behavior is preserved. Ork-only avatar changes follow LICENSE.md.

import { describe, expect, it } from "vitest";

import { avatarColor, isAvatarPhoto, withAvatarColor } from "./bot-avatar-edit";

describe("bot avatar editing", () => {
  it("writes only a colour when changing a legacy shape or plain avatar", () => {
    expect(withAvatarColor("#3EC5A8::shape_3", "#F5A03C")).toBe("#F5A03C");
    expect(withAvatarColor("#3EC5A8", "#F5A03C")).toBe("#F5A03C");
  });

  it("reads the saved colour from an obsolete shape suffix", () => {
    expect(avatarColor("#F5A03C::shape_5")).toBe("#F5A03C");
  });

  it("replaces a photo with a plain color", () => {
    const photo = "data:image/webp;base64,AAAA";
    expect(isAvatarPhoto(photo)).toBe(true);
    expect(isAvatarPhoto(avatarColor(photo))).toBe(false);
    expect(withAvatarColor(photo, "#6A6BF5")).toBe("#6A6BF5");
  });
});
