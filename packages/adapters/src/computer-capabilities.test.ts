// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ComputerRef, SandboxProvider } from "@orkbot/adapter-kit";
import { inspectComputerCapabilities } from "@orkbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ConfiguredSandbox } from "./configured-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { HostAwareSandbox } from "./host-aware-sandbox.js";
import { HostComputerSandbox } from "./host-computer-sandbox.js";
import { NoneSandboxProvider } from "./none-sandbox.js";

function cli() {
  const sandbox = new FakeSandboxProvider();
  const base = sandbox.describe();
  return Object.assign(sandbox, {
    describe: () => ({
      ...base,
      id: "desktop",
      capabilities: { ...base.capabilities, graphical: false, takeover: false, pty: false },
    }),
  });
}

describe("configured computer capabilities", () => {
  it("inspects the selected native target instead of the wrapper descriptor", async () => {
    const isolated = new FakeSandboxProvider();
    const host = cli();
    const provider = new HostAwareSandbox(isolated, host, async () => true);
    const provision = vi.spyOn(host, "provision");
    const screen = vi.spyOn(host, "connectScreen");
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      expect(await inspectComputerCapabilities(provider)).toEqual({
        start: true,
        screen: false,
        control: false,
        terminal: false,
      });
      expect(provision).not.toHaveBeenCalled();
      expect(screen).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("keeps the active screen after selecting a disabled target for the next start", async () => {
    const active = new FakeSandboxProvider();
    const provider = new HostAwareSandbox(new NoneSandboxProvider(), active, async () => false);
    expect(
      await inspectComputerCapabilities(provider, {
        computer: { kind: "desktop", botId: "home", providerRef: "active" },
      }),
    ).toEqual({ start: false, screen: true, control: true, terminal: true });
  });

  it("immediately hides a retained host screen after installation enrollment", async () => {
    let allowed = true;
    const provider = new HostAwareSandbox(
      new NoneSandboxProvider(),
      new FakeSandboxProvider(),
      async () => true,
      async () => allowed,
    );
    const input = { computer: { kind: "desktop", botId: "home", providerRef: "active" } } as const;
    expect((await inspectComputerCapabilities(provider, input)).screen).toBe(true);
    allowed = false;
    expect((await inspectComputerCapabilities(provider, input)).screen).toBe(false);
  });

  it("resolves an account's saved target before its first computer row exists", async () => {
    const loadOwn = vi.fn(async () => null);
    const loadOwnForUser = vi.fn(async () => ({ provider: "desktop", values: {} }));
    const target = new FakeSandboxProvider();
    const provision = vi.spyOn(target, "provision");
    const provider = new ConfiguredSandbox(
      new NoneSandboxProvider(),
      async () => ({ provider: "default", settings: null }),
      {
        loadOwn,
        loadOwnForUser,
        createProvider: async () => target,
      },
    );
    expect(
      await inspectComputerCapabilities(provider, { ownerUserId: "owner", homeKey: "team-home" }),
    ).toEqual({ start: true, screen: true, control: true, terminal: true });
    expect(loadOwnForUser).toHaveBeenCalledWith("owner");
    expect(loadOwn).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("uses the retained active reference and the newly selected start target separately", async () => {
    const active = cli();
    const provider = new ConfiguredSandbox(
      active,
      async () => ({ provider: "none", settings: { provider: "none", values: {} } }),
      { createProvider: async () => new NoneSandboxProvider() },
    );
    expect(
      await inspectComputerCapabilities(provider, {
        computer: { kind: "desktop", botId: "home", providerRef: "old" } as ComputerRef,
      }),
    ).toEqual({ start: false, screen: false, control: false, terminal: false });
  });

  it("does not reuse stale account routing after an authoritative removal", async () => {
    const loadOwn = vi.fn(async () => ({ provider: "desktop", values: {} }));
    const provider = new ConfiguredSandbox(
      new NoneSandboxProvider(),
      async () => ({ provider: "default", settings: null }),
      {
        loadOwn,
        loadOwnForUser: async () => null,
        createProvider: async () => new FakeSandboxProvider(),
      },
    );
    expect((await inspectComputerCapabilities(provider, { homeKey: "home" })).start).toBe(true);
    expect(
      (await inspectComputerCapabilities(provider, { homeKey: "home", ownerUserId: "owner" }))
        .start,
    ).toBe(false);
    expect(loadOwn).toHaveBeenCalledTimes(1);
  });

  it("keeps an unavailable active reference closed without hiding a usable next target", async () => {
    const provider = new ConfiguredSandbox(new FakeSandboxProvider(), async () => ({
      provider: "default",
      settings: null,
    }));
    expect(
      await inspectComputerCapabilities(provider, {
        computer: { kind: "boat", botId: "home", providerRef: "missing" },
      }),
    ).toEqual({ start: true, screen: false, control: false, terminal: false });
  });

  it("keeps an independent active primary usable when new account keys cannot be read", async () => {
    const provider = new ConfiguredSandbox(
      new FakeSandboxProvider(),
      async () => ({ provider: "default", settings: null }),
      {
        loadOwnForUser: async () => {
          throw new Error("store unavailable");
        },
      },
    );
    expect(
      await inspectComputerCapabilities(provider, {
        ownerUserId: "owner",
        computer: { kind: "fake", botId: "home", providerRef: "active" },
      }),
    ).toEqual({ start: false, screen: true, control: true, terminal: true });
  });

  it("keeps the active native reference usable when next-host settings cannot be read", async () => {
    const provider = new HostAwareSandbox(
      new NoneSandboxProvider(),
      new FakeSandboxProvider(),
      async () => {
        throw new Error("settings unavailable");
      },
    );
    expect(
      await inspectComputerCapabilities(provider, {
        computer: { kind: "desktop", botId: "home", providerRef: "active" },
      }),
    ).toEqual({ start: false, screen: true, control: true, terminal: true });
  });

  it("does not advertise a native start without its explicit transport credentials", async () => {
    const provider: SandboxProvider = new HostComputerSandbox("", "");
    expect((await inspectComputerCapabilities(provider)).start).toBe(false);
  });
});
