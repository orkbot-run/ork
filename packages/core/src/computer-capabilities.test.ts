// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it } from "vitest";
import { canConfigureComputers, computerCapabilitiesFor } from "./computer-capabilities.js";

describe("computer capabilities on native clients", () => {
  it("does not infer start or control from an older server's running screen", () => {
    expect(computerCapabilitiesFor({ screenAvailable: true, terminalAvailable: false })).toEqual({
      start: false,
      screen: true,
      control: false,
      terminal: false,
    });
  });
  it("does not apply a newer Team default to an unconfirmed older active target", () => {
    expect(
      computerCapabilitiesFor(
        { screenAvailable: true, terminalAvailable: false },
        { start: true, screen: true, control: true, terminal: true },
      ),
    ).toEqual({ start: false, screen: true, control: false, terminal: false });
  });
  it("keeps active-reference capabilities authoritative after defaults change", () => {
    const capabilities = { start: false, screen: true, control: true, terminal: true };
    expect(
      computerCapabilitiesFor(
        { capabilities, screenAvailable: true, terminalAvailable: true },
        { start: false, screen: false, control: false, terminal: false },
      ),
    ).toEqual(capabilities);
  });
  it("requires explicit account eligibility while retaining administrator access", () => {
    expect(canConfigureComputers({ isAdmin: false })).toBe(false);
    expect(canConfigureComputers({ isAdmin: false, canConfigureAccountComputers: true })).toBe(
      true,
    );
    expect(canConfigureComputers({ isAdmin: true })).toBe(true);
  });
});
