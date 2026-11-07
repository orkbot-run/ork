// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { beforeEach, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: vi.fn(async (key: string) => storage.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    storage.set(key, value);
  }),
}));

beforeEach(() => {
  vi.resetModules();
  storage.clear();
});

it("retries an offline retired session across launch with its own bearer and headers", async () => {
  const first = await import("./pending-revocations");
  const headers = { "x-proxy-secret": "old-proxy" };
  await first.queueSessionRevocation("https://old.example.test", "retired-token", headers);
  headers["x-proxy-secret"] = "new-proxy";
  const offline = vi.fn(async () => {
    throw Error("offline");
  });
  vi.stubGlobal("fetch", offline);
  await first.retryPendingRevocations();
  expect(storage.get("orkbot.pending-revocations")).toContain("retired-token");
  vi.resetModules();
  const restarted = await import("./pending-revocations");
  const online = vi.fn(async () => Response.json({ success: true }));
  vi.stubGlobal("fetch", online);
  await restarted.retryPendingRevocations();
  expect(online).toHaveBeenCalledWith(
    "https://old.example.test/api/auth/sign-out",
    expect.objectContaining({
      redirect: "error",
      credentials: "omit",
      body: "{}",
      headers: expect.objectContaining({
        authorization: "Bearer retired-token",
        "x-proxy-secret": "old-proxy",
        origin: "orkbot://",
      }),
    }),
  );
  expect(storage.get("orkbot.pending-revocations")).toBe("[]");
});

it("retains redirects and proxy refusals until revocation is acknowledged", async () => {
  const pending = await import("./pending-revocations");
  await pending.queueSessionRevocation("https://server.example.test", "old-token", {});
  const fetcher = vi.fn(
    async () =>
      new Response(null, { status: 302, headers: { location: "https://other.example.test" } }),
  );
  vi.stubGlobal("fetch", fetcher);
  await pending.retryPendingRevocations();
  expect(storage.get("orkbot.pending-revocations")).toContain("old-token");
  fetcher.mockResolvedValue(new Response(null, { status: 401 }));
  await pending.retryPendingRevocations();
  expect(storage.get("orkbot.pending-revocations")).toContain("old-token");
  fetcher.mockResolvedValue(new Response("<html>Sign in</html>", { status: 200 }));
  await pending.retryPendingRevocations();
  expect(storage.get("orkbot.pending-revocations")).toContain("old-token");
  fetcher.mockResolvedValue(Response.json({ success: true }));
  await pending.retryPendingRevocations();
  expect(storage.get("orkbot.pending-revocations")).toBe("[]");
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it("accepts an empty successful OAuth revocation response without mixing live credentials", async () => {
  const issuer = "https://accounts.example.test/realm";
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith("openid-configuration")
      ? Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          revocation_endpoint: `${issuer}/revoke`,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          response_types_supported: ["code"],
          id_token_signing_alg_values_supported: ["RS256"],
        })
      : new Response(null, { status: 200 }),
  );
  vi.stubGlobal("fetch", fetcher);
  const pending = await import("./pending-revocations");
  await pending.queueAccountsRevocation(
    issuer,
    "native-client",
    "retired-refresh",
    "refresh_token",
  );
  await pending.retryPendingRevocations();
  expect(fetcher).toHaveBeenLastCalledWith(
    `${issuer}/revoke`,
    expect.objectContaining({
      redirect: "error",
      credentials: "omit",
      body: "client_id=native-client&token=retired-refresh&token_type_hint=refresh_token",
    }),
  );
  expect(storage.get("orkbot.pending-revocations")).toBe("[]");
});
