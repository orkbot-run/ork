// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 behavior is preserved. Ork-only avatar changes follow LICENSE.md.

import { describe, expect, it } from "vitest";
import { mobileBotAvatarPresentation } from "./bot-avatar.js";

describe("mobile bot avatar presentation", () => {
  it("keeps the colour from obsolete shape markers without exposing legacy geometry", () => {
    expect(mobileBotAvatarPresentation("#8B5CF6::shape_3")).toEqual({
      kind: "color",
      color: "#A97EFE",
    });
    expect(mobileBotAvatarPresentation("#123456::shape_0")).toEqual({
      kind: "color",
      color: "#123456",
    });
  });

  it("draws a color saved as its earlier value as the current one", () => {
    expect(mobileBotAvatarPresentation("#8B5CF6")).toEqual({ kind: "color", color: "#A97EFE" });
    expect(mobileBotAvatarPresentation("#123456")).toEqual({ kind: "color", color: "#123456" });
  });

  it("still treats data images and remote URLs as before", () => {
    expect(mobileBotAvatarPresentation("data:image/png;base64,abc")).toEqual({
      kind: "image",
      imageUrl: "data:image/png;base64,abc",
    });
    expect(mobileBotAvatarPresentation("https://evil.example/track.png")).toEqual({
      kind: "other",
      raw: "https://evil.example/track.png",
    });
  });
});
