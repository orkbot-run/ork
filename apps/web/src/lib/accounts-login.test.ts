// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterEach, expect, it, vi } from "vitest";
import { signInWithNativeAccounts } from "./accounts-login";

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.orkbotDesktop;
});

function setup(bootstrapRequired = false) {
  const createServerLoginGrant = vi.fn().mockResolvedValue({
    grant: "audience-bound-proof",
    expiresAt: Date.now() / 1000 + 60,
  });
  const consumeServerInitializationSecret = vi.fn().mockResolvedValue("a".repeat(43));
  window.orkbotDesktop = {
    accounts: { createServerLoginGrant, consumeServerInitializationSecret },
  } as unknown as NonNullable<typeof window.orkbotDesktop>;
  const fetcher = vi
    .fn()
    .mockImplementation(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.endsWith("challenge")
              ? { challenge: "c".repeat(43), expiresAt: Date.now() / 1000 + 60, bootstrapRequired }
              : { user: { id: "server-user" }, token: "server-session" },
          ),
          { headers: { "content-type": "application/json" } },
        ),
    );
  vi.stubGlobal("fetch", fetcher);
  return { createServerLoginGrant, consumeServerInitializationSecret, fetcher };
}

it("sends only the proof to the current server and never opens an OIDC popup", async () => {
  const state = setup();
  await signInWithNativeAccounts();
  expect(state.createServerLoginGrant).toHaveBeenCalledWith({
    origin: window.location.origin,
    challenge: "c".repeat(43),
  });
  expect(state.consumeServerInitializationSecret).not.toHaveBeenCalled();
  expect(state.fetcher).toHaveBeenCalledTimes(2);
  const [url, request] = state.fetcher.mock.calls[1]!;
  expect(url).toBe("/api/auth/native/complete");
  expect(JSON.parse(request.body)).toEqual({
    challenge: "c".repeat(43),
    grant: "audience-bound-proof",
  });
  expect(request.headers.authorization).toBeUndefined();
  expect(request.redirect).toBe("error");
});

it("uses the operator's secret only when the server requires initialization", async () => {
  const state = setup(true);
  await signInWithNativeAccounts();
  expect(state.consumeServerInitializationSecret).toHaveBeenCalledTimes(1);
  expect(JSON.parse(state.fetcher.mock.calls[1]![1].body).bootstrapSecret).toBe("a".repeat(43));
});

it("refuses a fresh server without a confirmed initialization link", async () => {
  const state = setup(true);
  state.consumeServerInitializationSecret.mockResolvedValue(null);
  await expect(signInWithNativeAccounts()).rejects.toThrow("REGISTRATION_CLOSED");
  expect(state.createServerLoginGrant).not.toHaveBeenCalled();
  expect(state.fetcher).toHaveBeenCalledTimes(1);
});

it("rejects malformed challenges before requesting a native proof", async () => {
  const state = setup();
  state.fetcher.mockResolvedValue(
    new Response(JSON.stringify({ challenge: "bad", bootstrapRequired: false })),
  );
  await expect(signInWithNativeAccounts()).rejects.toThrow();
  expect(state.createServerLoginGrant).not.toHaveBeenCalled();
});

it("fails closed on an older native bridge", async () => {
  const state = setup();
  delete window.orkbotDesktop;
  await expect(signInWithNativeAccounts()).rejects.toThrow();
  expect(state.fetcher).not.toHaveBeenCalled();
});

it("never spends an expired native proof on the server", async () => {
  const state = setup();
  state.createServerLoginGrant.mockResolvedValue({
    grant: "expired",
    expiresAt: Date.now() / 1000 - 1,
  });
  await expect(signInWithNativeAccounts()).rejects.toThrow();
  expect(state.fetcher).toHaveBeenCalledTimes(1);
});
