// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 navigation tests are preserved. Immediate switching coverage follows LICENSE.md.

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("switching spaces in place", () => {
  it("commits immediately even when view transitions are available", async () => {
    const startViewTransition = vi.fn();
    vi.stubGlobal("document", { startViewTransition });
    const { remountShellForSpace } = await import("./space-switch");
    const commit = vi.fn(() => true);
    remountShellForSpace(commit);
    expect(commit).toHaveBeenCalledOnce();
    expect(startViewTransition).not.toHaveBeenCalled();
  });
});

describe("shell navigation", () => {
  it("uses the latest router navigate without replacing the guard", async () => {
    const { guardShellNavigate } = await import("./space-switch");
    const first = vi.fn();
    const latest = vi.fn();
    let navigate = first;
    const guarded = guardShellNavigate(
      () => navigate,
      () => true,
    );
    guarded("/app/a");
    navigate = latest;
    guarded("/app/b");
    expect(first).toHaveBeenCalledExactlyOnceWith("/app/a", undefined);
    expect(latest).toHaveBeenCalledExactlyOnceWith("/app/b", undefined);
  });

  it("navigates during the switch commit and ignores late work after unmount", async () => {
    const { guardShellNavigate, remountShellForSpace } = await import("./space-switch");
    const navigate = vi.fn();
    let alive = true;
    const guarded = guardShellNavigate(
      () => navigate,
      () => alive,
    );
    remountShellForSpace(() => {
      guarded("/app/bot-b", { replace: true });
      return true;
    });
    guarded(-1);
    expect(navigate.mock.calls).toEqual([["/app/bot-b", { replace: true }], [-1]]);
    alive = false;
    guarded("/app/bot-a");
    guarded(-1);
    expect(navigate).toHaveBeenCalledTimes(2);
  });
});

describe("space switch decision", () => {
  it("commits despite query and hash changes on the same pathname", async () => {
    const { spaceSwitchDecision } = await import("./space-switch");
    const started = new URL("https://example.test/app/bot-a");
    const current = new URL("https://example.test/app/bot-a?panel=files#preview");
    expect(spaceSwitchDecision(true, started.pathname, current.pathname, false)).toBe("commit");
  });

  it("abandons superseded requests and navigation to another pathname", async () => {
    const { spaceSwitchDecision } = await import("./space-switch");
    expect(spaceSwitchDecision(false, "/app/a", "/app/a", true)).toBe("abandon");
    expect(spaceSwitchDecision(true, "/app/a", "/app/c", false)).toBe("abandon");
  });

  it("reloads if a call starts before the switch commits", async () => {
    const { spaceSwitchDecision } = await import("./space-switch");
    expect(spaceSwitchDecision(true, "/app/a", "/app/a", true)).toBe("reload");
  });
});
