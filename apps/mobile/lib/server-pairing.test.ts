// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { beginServerPairing } from "./server-pairing";

const identity = vi.hoisted(() => ({
  version: 0,
  authorization: {
    issuer: "https://api.orkbot.run",
    subject: "account-a",
    accessToken: "native-test-token",
  } as { issuer: string; subject: string; accessToken: string } | null,
}));
vi.mock("./accounts", () => ({
  accountsVersion: () => identity.version,
  accountsAuthorization: async () => identity.authorization,
}));
vi.mock("./i18n", () => ({ t: (value: string) => value }));

const origin = "https://server.example.test";
const endpoint = "https://api.orkbot.run/api/server-pairings";
const owner = JSON.stringify(["https://api.orkbot.run", "account-a"]);
const ticket = { id: "a".repeat(64), code: "AB23CD", origin, expiresAt: 1_800_000_300 };
const response = (value: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  identity.version = 0;
  identity.authorization = {
    issuer: "https://api.orkbot.run",
    subject: "account-a",
    accessToken: "native-test-token",
  };
  fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(ticket));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("sends only the origin and native bearer to the fixed central endpoint", async () => {
  const session = await beginServerPairing(`${origin}/`, owner);
  expect(session.ticket).toEqual(ticket);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe(endpoint);
  expect(init).toMatchObject({
    method: "POST",
    body: JSON.stringify({ origin }),
    headers: { authorization: "Bearer native-test-token", "content-type": "application/json" },
    credentials: "omit",
    redirect: "error",
  });
  expect(Object.keys(init!.headers!)).toEqual(["authorization", "content-type"]);
});

it.each(["missing", "foreign-issuer", "different-owner"])(
  "does not create a code without the expected central identity (%s)",
  async (kind) => {
    if (kind === "missing") identity.authorization = null;
    else if (kind === "foreign-issuer")
      identity.authorization!.issuer = "https://other.example.test";
    else identity.authorization!.subject = "account-b";
    await expect(beginServerPairing(origin, owner)).rejects.toThrow("Sign in to Accounts");
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it.each(["http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000"])(
  "rejects loopback addresses before contacting Accounts (%s)",
  async (url) => {
    await expect(beginServerPairing(url, owner)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it.each([
  { id: "invalid" },
  { code: "ABC0D1" },
  { code: "AB2 3CD" },
  { origin: "https://other.example.test" },
  { expiresAt: 1_800_000_000 },
  { expiresAt: 1_800_000_600 },
])("refuses an invalid or differently bound ticket (%j)", async (change) => {
  fetchMock.mockResolvedValueOnce(response({ ...ticket, ...change }));
  await expect(beginServerPairing(origin, owner)).rejects.toThrow("Could not pair");
});

it("refreshes the native credential when polling but never forwards it to the selfhost", async () => {
  const session = await beginServerPairing(origin, owner);
  identity.authorization!.accessToken = "refreshed-native-test-token";
  fetchMock.mockResolvedValueOnce(response({ ...ticket, status: "ready" }));
  await expect(session.state()).resolves.toMatchObject({ status: "ready", origin });
  expect(fetchMock.mock.calls[1]).toMatchObject([
    `${endpoint}/${ticket.id}`,
    { method: "GET", headers: { authorization: "Bearer refreshed-native-test-token" } },
  ]);
});

it("cancels the original record with its original credential after an account switch", async () => {
  const session = await beginServerPairing(origin, owner);
  identity.version++;
  identity.authorization = {
    ...identity.authorization!,
    subject: "account-b",
    accessToken: "other-token",
  };
  fetchMock.mockResolvedValueOnce(response(undefined, 204));
  await session.cancel();
  await session.cancel();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]).toMatchObject([
    `${endpoint}/${ticket.id}`,
    { method: "DELETE", headers: { authorization: "Bearer native-test-token" } },
  ]);
  await expect(session.state()).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("revokes a late creation response instead of showing an old account's code", async () => {
  fetchMock
    .mockImplementationOnce(async () => {
      identity.version++;
      identity.authorization!.subject = "account-b";
      return response(ticket);
    })
    .mockResolvedValueOnce(response(undefined, 204));
  await expect(beginServerPairing(origin, owner)).rejects.toThrow("Sign in to Accounts");
  expect(fetchMock.mock.calls[1]).toMatchObject([
    `${endpoint}/${ticket.id}`,
    { method: "DELETE", headers: { authorization: "Bearer native-test-token" } },
  ]);
});

it("does not poll after the account is changed", async () => {
  const session = await beginServerPairing(origin, owner);
  identity.version++;
  await expect(session.state()).rejects.toThrow("Sign in to Accounts");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("ignores ready if the account changes during the poll", async () => {
  const session = await beginServerPairing(origin, owner);
  fetchMock.mockImplementationOnce(async () => {
    identity.version++;
    return response({ ...ticket, status: "ready" });
  });
  await expect(session.state()).rejects.toThrow("Sign in to Accounts");
});

it.each([
  { origin: "https://other.example.test" },
  { expiresAt: ticket.expiresAt + 1 },
  { status: "unknown" },
])("does not connect using a differently bound status response (%j)", async (change) => {
  const session = await beginServerPairing(origin, owner);
  fetchMock.mockResolvedValueOnce(response({ ...ticket, status: "ready", ...change }));
  await expect(session.state()).rejects.toThrow("Could not pair");
});

it("expires locally without polling the network again", async () => {
  const session = await beginServerPairing(origin, owner);
  vi.mocked(Date.now).mockReturnValue(ticket.expiresAt * 1000);
  await expect(session.state()).resolves.toEqual({
    status: "expired",
    origin,
    expiresAt: ticket.expiresAt,
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([401, 404, 429, 500])("fails safely for an unavailable broker (%s)", async (status) => {
  fetchMock.mockResolvedValueOnce(response({ error: "server detail" }, status));
  await expect(beginServerPairing(origin, owner)).rejects.toThrow(
    status === 401
      ? "Sign in to Accounts"
      : status === 429
        ? "Too many attempts"
        : "Could not pair",
  );
});
