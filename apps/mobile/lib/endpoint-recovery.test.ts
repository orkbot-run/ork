// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it, vi } from "vitest";
import { requireSupportedProtocol } from "./endpoint";

vi.mock("@orkbot/contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@orkbot/contracts")>()),
  CLIENT_PROTOCOL_VERSION: 2,
}));

it("allows older servers only for update recovery and rejects newer servers", () => {
  expect(requireSupportedProtocol({ protocol: { min: 1, max: 1 } }, true)).toBe("older");
  expect(requireSupportedProtocol({}, true)).toBe("older");
  expect(() => requireSupportedProtocol({ protocol: { min: 1, max: 1 } })).toThrow();
  expect(() => requireSupportedProtocol({ protocol: { min: 3, max: 3 } }, true)).toThrow();
  expect(requireSupportedProtocol({ protocol: { min: 2, max: 2 } }, true)).toBe("compatible");
});
