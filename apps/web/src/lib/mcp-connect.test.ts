// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectMcpOauth, MCP_OAUTH_CHANNEL, mcpOAuthRedirectUri } from "./mcp-connect";
import { rpc } from "./rpc";

const context = vi.hoisted(() => ({ isCurrent: vi.fn(() => true) }));
vi.mock("./rpc", () => {
  const rpc = { mcp: { oauth: { begin: vi.fn(), complete: vi.fn() } } };
  return { rpc, captureRpcContext: () => ({ client: rpc, isCurrent: context.isCurrent }) };
});

const authorization = "https://identity.example.test/authorize?state=fixture";

function environment(native: "desktop" | "hint" | "browser" = "desktop") {
  const channels: FakeChannel[] = [];
  class FakeChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    close = vi.fn();
    constructor(public name: string) {
      channels.push(this);
    }
  }
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  const popup = { closed: false, opener: {}, close: vi.fn(), location: { href: "about:blank" } };
  const location = { origin: "https://server.example.test", assign: vi.fn() };
  const open = vi.fn(() => popup);
  vi.stubGlobal("window", {
    ...(native === "desktop" ? { orkbotDesktop: {} } : {}),
    ...(native === "hint" ? { orkbotNativeAuth: { ssoPopup: true } } : {}),
    location,
    open,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  vi.stubGlobal("document", { hasFocus: () => true });
  return { popup, location, open, channels };
}

beforeEach(() => {
  vi.useFakeTimers();
  context.isCurrent.mockReset().mockReturnValue(true);
  vi.mocked(rpc.mcp.oauth.complete).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(rpc.mcp.oauth.begin).mockReset().mockResolvedValue({
    status: "authorization_required",
    sessionId: "session-fixture",
    authorizationUrl: authorization,
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["desktop", "hint"] as const)(
  "keeps MCP OAuth in the native shared-session popup (%s)",
  async (native) => {
    const { popup, location, open, channels } = environment(native);
    let navigated = "";
    Object.defineProperty(popup.location, "href", {
      set(url: string) {
        navigated = url;
        expect(popup.opener).toBeNull();
        // A provider with an existing grant may finish during the first navigation.
        channels[0]?.onmessage?.({ data: { type: "mcp-oauth-complete" } });
      },
    });
    await expect(connectMcpOauth("server-fixture")).resolves.toBe("connected");
    expect(rpc.mcp.oauth.begin).toHaveBeenCalledWith({
      serverId: "server-fixture",
    });
    expect(open).toHaveBeenCalledWith("about:blank", MCP_OAUTH_CHANNEL, expect.any(String));
    expect(navigated).toBe(authorization);
    expect(location.assign).not.toHaveBeenCalled();
    expect(channels[0]?.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("keeps the product in place when the native popup is refused", async () => {
  const { open, location } = environment();
  open.mockReturnValue(null as never);
  await expect(connectMcpOauth("server-fixture")).resolves.toBe("cancelled");
  expect(location.assign).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans up a refused native popup navigation without moving the product", async () => {
  const { popup, location, channels } = environment();
  Object.defineProperty(popup.location, "href", {
    set() {
      throw new Error("Popup navigation refused");
    },
  });
  await expect(connectMcpOauth("server-fixture")).resolves.toBe("cancelled");
  expect(popup.close).toHaveBeenCalledOnce();
  expect(channels[0]?.close).toHaveBeenCalledOnce();
  expect(location.assign).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans up native cancellation and ignores unrelated callback messages", async () => {
  const { popup, location, channels } = environment();
  const result = connectMcpOauth("server-fixture");
  await vi.advanceTimersByTimeAsync(0);
  channels[0]?.onmessage?.({ data: { type: "other-oauth-complete" } });
  popup.closed = true;
  await vi.advanceTimersByTimeAsync(500);
  await expect(result).resolves.toBe("cancelled");
  expect(location.assign).not.toHaveBeenCalled();
  expect(channels[0]?.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves the browser fallback when no native session popup is available", async () => {
  const { open, location } = environment("browser");
  open.mockReturnValue(null as never);
  await expect(connectMcpOauth("server-fixture")).resolves.toBe("cancelled");
  expect(open).toHaveBeenCalledWith(authorization, MCP_OAUTH_CHANNEL, expect.any(String));
  expect(location.assign).toHaveBeenCalledWith(authorization);
});

it("does not open an authorization popup when the server is already connected", async () => {
  const { open } = environment();
  vi.mocked(rpc.mcp.oauth.begin).mockResolvedValue({ status: "already_connected" });
  await expect(connectMcpOauth("server-fixture")).resolves.toBe("already_connected");
  expect(open).not.toHaveBeenCalled();
});

it("uses the installation callback address in bundled-renderer setup", () => {
  expect(mcpOAuthRedirectUri("https://installation.example.test")).toBe(
    "https://installation.example.test/mcp/oauth/callback",
  );
  expect(mcpOAuthRedirectUri()).toBe("/mcp/oauth/callback");
});

it("captures the native callback and completes through the initiating workspace session", async () => {
  const { open } = environment();
  const capture = vi.fn().mockResolvedValue({ code: "provider-code", state: "session-fixture" });
  window.orkbotDesktop = { oauth: { capture } } as never;
  await expect(connectMcpOauth("server-fixture")).resolves.toBe("connected");
  expect(capture).toHaveBeenCalledWith(authorization, "session-fixture");
  expect(rpc.mcp.oauth.complete).toHaveBeenCalledWith({
    sessionId: "session-fixture",
    code: "provider-code",
    state: "session-fixture",
  });
  expect(open).not.toHaveBeenCalled();
});

it.each(["session", "state", "failure"])(
  "rejects late or mismatched native completion (%s)",
  async (change) => {
    environment();
    const capture = vi.fn(async () => {
      if (change === "failure") throw new Error("closed");
      if (change === "session") context.isCurrent.mockReturnValue(false);
      return {
        code: "provider-code",
        state: change === "state" ? "other-session" : "session-fixture",
      };
    });
    window.orkbotDesktop = { oauth: { capture } } as never;
    await expect(connectMcpOauth("server-fixture")).resolves.toBe("cancelled");
    expect(rpc.mcp.oauth.complete).not.toHaveBeenCalled();
  },
);

it("reports a failed server-side token exchange instead of treating it as user cancellation", async () => {
  environment();
  window.orkbotDesktop = {
    oauth: {
      capture: vi.fn().mockResolvedValue({ code: "provider-code", state: "session-fixture" }),
    },
  } as never;
  vi.mocked(rpc.mcp.oauth.complete).mockRejectedValue(new Error("Token exchange rejected"));
  await expect(connectMcpOauth("server-fixture")).rejects.toThrow("Token exchange rejected");
});
