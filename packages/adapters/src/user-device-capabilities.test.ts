// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it, vi } from "vitest";
import { userDeviceScreenAvailable } from "./user-device-capabilities.js";
import type { UserDeviceGateway } from "./user-device-protocol.js";

describe("paired screen capabilities", () => {
  it.each([true, false])("uses the matched device's capability: %s", async (enabled) => {
    const request = vi.fn(async function* () {
      yield { screen: enabled, control: enabled };
    });
    const devices = { request } as unknown as UserDeviceGateway;
    expect(
      await userDeviceScreenAvailable(
        devices,
        "owner",
        "matched-device",
        "bot",
        new AbortController().signal,
      ),
    ).toBe(enabled);
    expect(request).toHaveBeenCalledWith(
      "owner",
      { method: "capabilities", botId: "bot" },
      expect.any(AbortSignal),
      "matched-device",
    );
  });
  it("denies missing or disconnected native bridges", async () => {
    const devices = {
      request: async function* () {
        yield await Promise.reject(new Error("unavailable"));
      },
    } as unknown as UserDeviceGateway;
    expect(
      await userDeviceScreenAvailable(
        devices,
        "owner",
        "device",
        "bot",
        new AbortController().signal,
      ),
    ).toBe(false);
  });
  it("denies an older device response and capture without control permission", async () => {
    for (const value of [{}, { screen: true }, { screen: true, control: false }]) {
      const devices = {
        request: async function* () {
          yield value;
        },
      } as unknown as UserDeviceGateway;
      expect(
        await userDeviceScreenAvailable(
          devices,
          "owner",
          "device",
          "bot",
          new AbortController().signal,
        ),
      ).toBe(false);
    }
  });
});
