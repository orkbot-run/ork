// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved. Capability changes follow LICENSE.md.

import { describe, expect, it, vi } from "vitest";
import {
  computersAreUnavailable,
  refreshSandboxFromServer,
  sandboxCheckFailureMessage,
} from "./computer-sandbox.js";

vi.mock("./rpc", () => ({ captureRpcContext: vi.fn() }));

describe("computer availability", () => {
  it("requires explicit server capability rather than a configured provider identifier", () => {
    expect(computersAreUnavailable(undefined)).toBe(true);
    expect(computersAreUnavailable(null)).toBe(true);
    expect(
      computersAreUnavailable({ start: false, screen: true, control: true, terminal: true }),
    ).toBe(true);
    expect(
      computersAreUnavailable({ start: true, screen: false, control: false, terminal: false }),
    ).toBe(false);
  });
  it("rejects a recovery from a retired origin after both reads settle", async () => {
    const me = {
      computerCapabilities: { start: true, screen: true, control: true, terminal: true },
    };
    const origin = {
      client: { health: vi.fn(async () => ({ ok: true })), me: vi.fn(async () => me) },
      isCurrent: () => false,
    };
    await expect(refreshSandboxFromServer(origin as never)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
  it("keeps a failed health response unavailable", async () => {
    const origin = {
      client: { health: vi.fn(async () => ({ ok: false })), me: vi.fn(async () => ({})) },
      isCurrent: () => true,
    };
    await expect(refreshSandboxFromServer(origin as never)).rejects.toThrow(
      "Server health check failed",
    );
  });
});

describe("sandboxCheckFailureMessage", () => {
  it("returns error message or fallback", () => {
    expect(sandboxCheckFailureMessage(new Error("offline"))).toBe("offline");
    expect(sandboxCheckFailureMessage(null)).toBe("Could not reach the server");
  });
});
