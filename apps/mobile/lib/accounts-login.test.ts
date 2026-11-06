// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { beforeEach, expect, it, vi } from "vitest";
import { continueWithAccountsServer } from "./accounts-login";
import {
  confirmServerInitialization,
  receiveServerConnect,
  serverInitializationSecret,
} from "./server-connect";

const state = vi.hoisted(() => ({
  origin: "https://server.example.test",
  generation: 1,
  identity: {
    issuer: "https://accounts.example.test",
    subject: "owner",
    accessToken: "central-bearer",
  },
  request: vi.fn(),
  replace: vi.fn(),
  clearSpace: vi.fn(),
}));
vi.mock("./accounts", () => ({ accountsAuthorization: async () => state.identity }));
vi.mock("./api", () => ({
  currentApiBase: () => state.origin,
  fetchMobileJson: (...args: unknown[]) => state.request(...args),
  clearSpace: () => state.clearSpace(),
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => state.generation,
  replaceSessionTokenIfCurrent: (...args: unknown[]) => state.replace(...args),
}));
vi.mock("./i18n", () => ({ t: (text: string) => text }));

beforeEach(() => {
  state.origin = "https://server.example.test";
  state.generation = 1;
  state.identity = {
    issuer: "https://accounts.example.test",
    subject: "owner",
    accessToken: "central-bearer",
  };
  state.replace.mockReset().mockResolvedValue(true);
  state.clearSpace.mockReset().mockResolvedValue(true);
  receiveServerConnect("orkbot://connect?server=https%3A%2F%2Fserver.example.test");
  state.request.mockReset().mockImplementation(async (url: string) => ({
    response: new Response(null, { status: 200 }),
    body: url.endsWith("challenge")
      ? {
          challenge: "c".repeat(43),
          expiresAt: Date.now() / 1000 + 60,
          bootstrapRequired: false,
        }
      : url.endsWith("server-login-grants")
        ? {
            grant: "audience-bound-proof",
            expiresAt: Date.now() / 1000 + 60,
          }
        : { token: "server-session", user: { id: "server-user" } },
  }));
});

it("keeps the central bearer on Accounts and saves only the local server session", async () => {
  expect(await continueWithAccountsServer()).toBe(true);
  expect(state.request.mock.calls.map(([url]) => url)).toEqual([
    `${state.origin}/api/auth/native/challenge`,
    `${state.identity.issuer}/api/server-login-grants`,
    `${state.origin}/api/auth/native/complete`,
  ]);
  for (const [url, request] of state.request.mock.calls) {
    expect(request.headers.authorization).toBe(
      url.startsWith(state.identity.issuer) ? "Bearer central-bearer" : undefined,
    );
    expect(request.headers.origin).toBe(
      url.startsWith(state.identity.issuer) ? undefined : "orkbot://",
    );
    expect(request.redirect).toBe("error");
  }
  expect(state.replace).toHaveBeenCalledWith(1, "server-session", "sign_in");
});

it("does not complete sign-in if the central account changes while issuing the proof", async () => {
  const original = state.request.getMockImplementation()!;
  state.request.mockImplementation(async (...args: unknown[]) => {
    const result = await original(...args);
    if (String(args[0]).endsWith("server-login-grants"))
      state.identity = { ...state.identity, subject: "other" };
    return result;
  });
  await expect(continueWithAccountsServer()).rejects.toThrow();
  expect(state.request).toHaveBeenCalledTimes(2);
  expect(state.replace).not.toHaveBeenCalled();
});

it("does not save a session after switching servers during completion", async () => {
  const original = state.request.getMockImplementation()!;
  state.request.mockImplementation(async (...args: unknown[]) => {
    const result = await original(...args);
    if (String(args[0]).endsWith("complete")) state.origin = "https://other.example.test";
    return result;
  });
  await expect(continueWithAccountsServer()).rejects.toThrow();
  expect(state.replace).not.toHaveBeenCalled();
});

it("requires confirmation of both server and account before releasing a bootstrap secret", async () => {
  const secret = "s".repeat(43);
  receiveServerConnect(
    `orkbot://initialize?server=${encodeURIComponent(state.origin)}&secret=${secret}`,
  );
  confirmServerInitialization(
    state.origin,
    JSON.stringify([state.identity.issuer, state.identity.subject]),
  );
  const original = state.request.getMockImplementation()!;
  state.request.mockImplementation(async (...args: unknown[]) => {
    const result = await original(...args);
    if (String(args[0]).endsWith("challenge")) result.body.bootstrapRequired = true;
    return result;
  });
  expect(await continueWithAccountsServer()).toBe(true);
  expect(JSON.parse(state.request.mock.calls[2]![1].body).bootstrapSecret).toBe(secret);
  await expect(continueWithAccountsServer()).rejects.toThrow();
  expect(state.replace).toHaveBeenCalledTimes(1);
});

it("keeps initialization available after a failed grant request", async () => {
  receiveServerConnect(
    `orkbot://initialize?server=${encodeURIComponent(state.origin)}&secret=${"s".repeat(43)}`,
  );
  confirmServerInitialization(
    state.origin,
    JSON.stringify([state.identity.issuer, state.identity.subject]),
  );
  const request = state.request.getMockImplementation()!;
  let failed = false;
  state.request.mockImplementation(async (...args: unknown[]) => {
    if (String(args[0]).endsWith("server-login-grants") && !failed) {
      failed = true;
      throw new Error("connection lost");
    }
    const result = await request(...args);
    if (String(args[0]).endsWith("challenge")) result.body.bootstrapRequired = true;
    return result;
  });
  await expect(continueWithAccountsServer()).rejects.toThrow();
  expect(await continueWithAccountsServer()).toBe(true);
  const completion = state.request.mock.calls.find(([url]) => String(url).endsWith("complete"));
  expect(JSON.parse(completion![1].body).bootstrapSecret).toBe("s".repeat(43));
  expect(state.replace).toHaveBeenCalledOnce();
});

it("keeps a second attempt out until the session has been saved", async () => {
  let saved: (value: boolean) => void = () => undefined;
  let saving: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    saving = resolve;
  });
  state.replace.mockImplementation(() => {
    saving();
    return new Promise<boolean>((resolve) => {
      saved = resolve;
    });
  });
  const first = continueWithAccountsServer();
  await started;
  expect(await continueWithAccountsServer()).toBe(false);
  saved(true);
  expect(await first).toBe(true);
});

it("preserves a newer initialization link when an older attempt completes", async () => {
  const account = JSON.stringify([state.identity.issuer, state.identity.subject]);
  receiveServerConnect(
    `orkbot://initialize?server=${encodeURIComponent(state.origin)}&secret=${"a".repeat(43)}`,
  );
  confirmServerInitialization(state.origin, account);
  const request = state.request.getMockImplementation()!;
  state.request.mockImplementation(async (...args: unknown[]) => {
    const result = await request(...args);
    if (String(args[0]).endsWith("challenge")) result.body.bootstrapRequired = true;
    if (String(args[0]).endsWith("complete")) {
      receiveServerConnect(
        `orkbot://initialize?server=${encodeURIComponent(state.origin)}&secret=${"b".repeat(43)}`,
      );
      confirmServerInitialization(state.origin, account);
    }
    return result;
  });
  expect(await continueWithAccountsServer()).toBe(true);
  expect(serverInitializationSecret(state.origin, account)).toBe("b".repeat(43));
});
