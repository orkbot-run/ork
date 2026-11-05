// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Modified for the Tauri desktop path. Inherited material remains Apache-2.0.

import { describe, expect, it, vi } from "vitest";
import type { OrkDesktop } from "../lib/desktop.js";
import { registerServiceWorker } from "./register.js";

function host(desktop?: OrkDesktop) {
  const register = vi.fn(async () => ({}));
  const target = new EventTarget() as EventTarget & Parameters<typeof registerServiceWorker>[0];
  Object.assign(target, {
    navigator: { serviceWorker: { register } },
    orkbotDesktop: desktop,
  });
  return { target, register };
}

describe("registerServiceWorker", () => {
  it("registers after load in production browsers", () => {
    const { target, register } = host();
    registerServiceWorker(target, true);
    expect(register).not.toHaveBeenCalled();
    target.dispatchEvent(new Event("load"));
    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("stays off in dev and inside the desktop app", () => {
    const dev = host();
    registerServiceWorker(dev.target, false);
    dev.target.dispatchEvent(new Event("load"));
    expect(dev.register).not.toHaveBeenCalled();

    const desktop = host({} as OrkDesktop);
    registerServiceWorker(desktop.target, true);
    desktop.target.dispatchEvent(new Event("load"));
    expect(desktop.register).not.toHaveBeenCalled();
  });
});
