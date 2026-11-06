// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it } from "vitest";
import { normalizeServerPairingCode, SERVER_PAIRING_ALPHABET } from "./server-pairing.js";

it("normalizes copied display groups without accepting ambiguous or non-ASCII symbols", () => {
  expect(new Set(SERVER_PAIRING_ALPHABET).size).toBe(32);
  for (const input of ["K7MP2Q", "k7mp2q", "K7M-P2Q", " K7M P2Q "])
    expect(normalizeServerPairingCode(input)).toBe("K7MP2Q");
  for (const input of [
    null,
    {},
    "",
    "K7MP2",
    "K7MP2QX",
    "I7MP2Q",
    "O7MP2Q",
    "17MP2Q",
    "07MP2Q",
    "K7MＰ2Q",
    "K7MP2Q&",
    "K7MP2Q".repeat(3),
  ])
    expect(normalizeServerPairingCode(input)).toBeNull();
});
