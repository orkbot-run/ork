// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/** A call's exclusive speaker admission, valid only for this lifetime. */
export interface SpeakerClaim {
  isCurrent(): boolean;
  release(): void;
}

/** Playback stays platform-owned; this only arbitrates who may start it. */
export function createSpeakerOwnership() {
  let current: SpeakerClaim | undefined;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    claim(): SpeakerClaim | undefined {
      if (current) return undefined;
      const claim: SpeakerClaim = {
        isCurrent: () => current === claim,
        release() {
          if (current !== claim) return;
          current = undefined;
          emit();
        },
      };
      current = claim;
      emit();
      return claim;
    },
    allows: (claim?: SpeakerClaim) => (claim ? current === claim : current === undefined),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear() {
      current?.release();
    },
  };
}
