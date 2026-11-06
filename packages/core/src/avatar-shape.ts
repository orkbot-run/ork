// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to use generated Ork avatars and retire legacy icon rendering.
// Inherited Apache-2.0 material is preserved. New changes follow LICENSE.md.

export function avatarIdentitySeed(identity: string): number {
  let hash = 0;
  for (let index = 0; index < identity.length; index++) {
    hash = (hash << 5) - hash + identity.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

/** Two eyes of one size, placed by their centres in the avatar's own view box. */
export interface AvatarEyes {
  readonly width: number;
  readonly height: number;
  readonly leftCx: number;
  readonly rightCx: number;
  readonly cy: number;
}

/** Organic bodies come in this many families; the seed picks one. */
export const ORGANIC_AVATAR_FAMILY_COUNT = 10;

/** The body with two upper lobes, a central notch and a pointed bottom. */
export const ORGANIC_AVATAR_HEART_FAMILY = 6;

/** The organic body family every client draws for this identity (a bot's id). */
export function organicAvatarFamily(identity: string): number {
  return avatarIdentitySeed(identity) % ORGANIC_AVATAR_FAMILY_COUNT;
}

/** Families 2 and 8 are both round blobs, so they count as one look when telling bots apart. */
export function organicAvatarLook(family: number): number {
  return family === 8 ? 2 : family;
}

/** The distinct organic bodies a new bot can get: every look except the heart. */
export const ORGANIC_AVATAR_LOOKS: readonly number[] = [
  ...new Set(
    Array.from({ length: ORGANIC_AVATAR_FAMILY_COUNT }, (_, family) => family)
      .filter((family) => family !== ORGANIC_AVATAR_HEART_FAMILY)
      .map(organicAvatarLook),
  ),
];

/** A stable identity whose organic body is the given family, for previews before a bot has an id. */
export function organicAvatarSampleIdentity(family: number): string {
  for (let index = 0; ; index++) {
    const identity = `look-${family}-${index}`;
    if (organicAvatarFamily(identity) === family) return identity;
  }
}
