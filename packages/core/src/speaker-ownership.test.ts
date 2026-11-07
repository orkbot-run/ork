// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it, vi } from "vitest";
import { createSpeakerOwnership } from "./speaker-ownership.js";

it("admits only the call holding the speaker, including its silent phases", () => {
  const ownership = createSpeakerOwnership();
  const changed = vi.fn();
  const unsubscribe = ownership.subscribe(changed);
  expect(ownership.allows()).toBe(true);
  const first = ownership.claim()!;
  expect(first.isCurrent()).toBe(true);
  expect(ownership.allows()).toBe(false);
  expect(ownership.allows(first)).toBe(true);
  expect(ownership.claim()).toBeUndefined();
  first.release();
  expect(ownership.allows(first)).toBe(false);
  const second = ownership.claim()!;
  first.release();
  expect(ownership.allows(second)).toBe(true);
  ownership.clear();
  expect(second.isCurrent()).toBe(false);
  expect(ownership.allows(second)).toBe(false);
  expect(ownership.allows()).toBe(true);
  expect(changed).toHaveBeenCalledTimes(4);
  unsubscribe();
  ownership.claim();
  expect(changed).toHaveBeenCalledTimes(4);
});
