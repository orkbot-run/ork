// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it } from "vitest";
import { stripDirectionalControls } from "./directional-controls.js";

describe("stripDirectionalControls", () => {
  it("removes each bidi formatting control from identity labels", () => {
    const controls = "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
    for (const control of controls) {
      expect(stripDirectionalControls(`Al${control}ice`)).toBe("Alice");
    }
  });

  it("preserves readable RTL, mixed scripts, combining marks and emoji joiners", () => {
    const name = "Alice שלום مريم می‌نا 👩‍💻 é";
    expect(stripDirectionalControls(name)).toBe(name);
    expect(stripDirectionalControls(stripDirectionalControls(`\u202e${name}`))).toBe(name);
  });
});
