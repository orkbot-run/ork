// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { expect, it } from "vitest";
import { logoAvatarTraits, seededLogoAvatarColor } from "./logo-avatar-traits.js";
import { createPersonalOrkId, isPersonalOrkId } from "./personal-ork.js";

it("creates independent portable Orks whose appearance survives restoring their seed", () => {
  const ids = Array.from({ length: 40 }, createPersonalOrkId);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) {
    expect(isPersonalOrkId(id)).toBe(true);
    const restored = JSON.parse(JSON.stringify(id));
    expect(logoAvatarTraits(restored, seededLogoAvatarColor(restored))).toEqual(
      logoAvatarTraits(id, seededLogoAvatarColor(id)),
    );
  }
  expect(
    new Set(ids.map((id) => JSON.stringify(logoAvatarTraits(id).appearance))).size,
  ).toBeGreaterThan(1);
});

it.each([
  null,
  undefined,
  {},
  "",
  "ork-welcome-10099",
  "123e4567-e89b-12d3-a456-426614174000",
  "../../account",
  "<svg onload=alert(1)>",
])("rejects malformed account seed %s", (value) => {
  expect(isPersonalOrkId(value)).toBe(false);
});
