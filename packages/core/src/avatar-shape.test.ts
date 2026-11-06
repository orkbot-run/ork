// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to use generated Ork avatars and retire legacy icon rendering.
// Inherited Apache-2.0 material is preserved. New changes follow LICENSE.md.

import { describe, expect, it } from "vitest";
import {
  avatarIdentitySeed,
  ORGANIC_AVATAR_FAMILY_COUNT,
  ORGANIC_AVATAR_HEART_FAMILY,
  ORGANIC_AVATAR_LOOKS,
  organicAvatarFamily,
  organicAvatarSampleIdentity,
} from "./avatar-shape.js";

describe("legacy identity metadata", () => {
  it("keeps identity seeds stable for stored family metadata", () => {
    for (const identity of ["research", "health", "c0123456789abcdef01234567"]) {
      expect(avatarIdentitySeed(identity)).toBe(avatarIdentitySeed(identity));
      expect(organicAvatarFamily(identity)).toBe(
        avatarIdentitySeed(identity) % ORGANIC_AVATAR_FAMILY_COUNT,
      );
    }
  });
});

describe("organic avatar looks", () => {
  it("offers every look but the heart once", () => {
    expect([...ORGANIC_AVATAR_LOOKS].sort()).toEqual([0, 1, 2, 3, 4, 5, 7, 9]);
    expect(ORGANIC_AVATAR_LOOKS).not.toContain(ORGANIC_AVATAR_HEART_FAMILY);
  });

  it("finds a stable sample identity for each family", () => {
    for (let family = 0; family < ORGANIC_AVATAR_FAMILY_COUNT; family++) {
      const identity = organicAvatarSampleIdentity(family);
      expect(organicAvatarFamily(identity)).toBe(family);
      expect(organicAvatarSampleIdentity(family)).toBe(identity);
    }
  });
});
