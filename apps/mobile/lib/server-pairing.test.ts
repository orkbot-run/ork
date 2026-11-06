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
const ticket = { id: "a".repeat(64), code: "AB23CD", expiresAt: 1_800_000_300 };
const status = (state: string, server: string | null = origin) => ({
  status: state,
  origin: server,
  expiresAt: ticket.expiresAt,
});
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

it("creates an origin-free code with only the native bearer at Accounts", async () => {
  const session = await beginServerPairing(owner);
  expect(session.ticket).toEqual(ticket);
  expect(session.ticket).not.toHaveProperty("origin");
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe(endpoint);
  expect(init).toMatchObject({
    method: "POST",
    body: "{}",
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
    await expect(beginServerPairing(owner)).rejects.toThrow("Sign in to Accounts");
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it.each([
  { id: "invalid" },
  { code: "ABC0D1" },
  { code: "AB2 3CD" },
  { expiresAt: 1_800_000_000 },
  { expiresAt: 1_800_000_600 },
])("refuses an invalid ticket (%j)", async (change) => {
  fetchMock.mockResolvedValueOnce(response({ ...ticket, ...change }));
  await expect(beginServerPairing(owner)).rejects.toThrow("Could not pair");
});

it("refreshes the credential when polling without forwarding it to a selfhost", async () => {
  const session = await beginServerPairing(owner);
  identity.authorization!.accessToken = "refreshed-native-test-token";
  fetchMock.mockResolvedValueOnce(response(status("pending", null)));
  await expect(session.state()).resolves.toEqual(status("pending", null));
  expect(fetchMock.mock.calls[1]).toMatchObject([
    `${endpoint}/${ticket.id}`,
    { method: "GET", headers: { authorization: "Bearer refreshed-native-test-token" } },
  ]);
});

it("requires a claimed origin and explicit approval before accepting ready", async () => {
  const session = await beginServerPairing(owner);
  await expect(session.approve(origin)).rejects.toThrow("Could not pair");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockResolvedValueOnce(response(status("approval-required")));
  await expect(session.state()).resolves.toEqual(status("approval-required"));
  await expect(session.approve("https://other.example.test")).rejects.toThrow("Could not pair");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  identity.authorization!.accessToken = "refreshed-native-test-token";
  fetchMock.mockResolvedValueOnce(response(status("approved")));
  await expect(session.approve(origin)).resolves.toEqual(status("approved"));
  expect(fetchMock.mock.calls[2]).toMatchObject([
    `${endpoint}/${ticket.id}/approve`,
    {
      method: "POST",
      body: JSON.stringify({ origin }),
      headers: {
        authorization: "Bearer refreshed-native-test-token",
        "content-type": "application/json",
      },
      credentials: "omit",
      redirect: "error",
    },
  ]);
  fetchMock.mockResolvedValueOnce(response(status("ready")));
  await expect(session.state()).resolves.toEqual(status("ready"));
});

it.each(["approved", "ready"])("rejects unsolicited %s before a local approval", async (value) => {
  const session = await beginServerPairing(owner);
  fetchMock.mockResolvedValueOnce(response(status(value)));
  await expect(session.state()).rejects.toThrow("Could not pair");
});

it.each(["approval-required", "approved", "ready", "failed", "expired"])(
  "cannot replace the first claimed domain in %s",
  async (value) => {
    const session = await beginServerPairing(owner);
    fetchMock.mockResolvedValueOnce(response(status("approval-required")));
    await session.state();
    fetchMock.mockResolvedValueOnce(response(status(value, "https://other.example.test")));
    await expect(session.state()).rejects.toThrow("Could not pair");
  },
);

it.each([
  "https://server.example.test/path",
  "https://name@server.example.test",
  "http://public.example.test",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
  "https://server.example.test/",
  "https://server.example.test?token=value",
])("does not display or approve a noncanonical selfhost origin (%s)", async (server) => {
  const session = await beginServerPairing(owner);
  fetchMock.mockResolvedValueOnce(response(status("approval-required", server)));
  await expect(session.state()).rejects.toThrow("Could not pair");
  await expect(session.approve(server)).rejects.toThrow("Could not pair");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([
  status("pending"),
  status("approval-required", null),
  status("approved", null),
  { ...status("pending", null), origin: undefined },
  { ...status("pending", null), expiresAt: ticket.expiresAt + 1 },
  status("unknown", null),
])("rejects malformed claim state (%j)", async (value) => {
  const session = await beginServerPairing(owner);
  fetchMock.mockResolvedValueOnce(response(value));
  await expect(session.state()).rejects.toThrow("Could not pair");
});

it("cancels the original record with its original credential after switching accounts", async () => {
  const session = await beginServerPairing(owner);
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
  await expect(session.approve(origin)).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("revokes a late creation response instead of displaying an old account's code", async () => {
  fetchMock
    .mockImplementationOnce(async () => {
      identity.version++;
      identity.authorization!.subject = "account-b";
      return response(ticket);
    })
    .mockResolvedValueOnce(response(undefined, 204));
  await expect(beginServerPairing(owner)).rejects.toThrow("Sign in to Accounts");
  expect(fetchMock.mock.calls[1]).toMatchObject([
    `${endpoint}/${ticket.id}`,
    { method: "DELETE", headers: { authorization: "Bearer native-test-token" } },
  ]);
});

it("does not poll after the account changes", async () => {
  const session = await beginServerPairing(owner);
  identity.version++;
  await expect(session.state()).rejects.toThrow("Sign in to Accounts");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each(["before", "during"])("does not approve for a changed account (%s)", async (when) => {
  const session = await beginServerPairing(owner);
  fetchMock.mockResolvedValueOnce(response(status("approval-required")));
  await session.state();
  if (when === "before") identity.version++;
  else
    fetchMock.mockImplementationOnce(async () => {
      identity.version++;
      return response(status("approved"));
    });
  await expect(session.approve(origin)).rejects.toThrow("Sign in to Accounts");
  if (when === "before") expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each(["ready", "approval-required"])(
  "does not treat an unexpected approval response as consent (%s)",
  async (value) => {
    const session = await beginServerPairing(owner);
    fetchMock.mockResolvedValueOnce(response(status("approval-required")));
    await session.state();
    fetchMock.mockResolvedValueOnce(response(status(value)));
    await expect(session.approve(origin)).rejects.toThrow("Could not pair");
    fetchMock.mockResolvedValueOnce(response(status("ready")));
    await expect(session.state()).rejects.toThrow("Could not pair");
  },
);

it("ignores a status response after its request is cancelled", async () => {
  const session = await beginServerPairing(owner);
  const controller = new AbortController();
  fetchMock.mockImplementationOnce(async () => {
    controller.abort();
    return response(status("approval-required"));
  });
  await expect(session.state(controller.signal)).rejects.toThrow();
});

it.each([false, true])(
  "expires locally while preserving the claimed domain (%s)",
  async (claimed) => {
    const session = await beginServerPairing(owner);
    if (claimed) {
      fetchMock.mockResolvedValueOnce(response(status("approval-required")));
      await session.state();
    }
    const count = fetchMock.mock.calls.length;
    vi.mocked(Date.now).mockReturnValue(ticket.expiresAt * 1000);
    await expect(session.state()).resolves.toEqual(status("expired", claimed ? origin : null));
    await expect(session.approve(origin)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(count);
  },
);

it.each([401, 404, 429, 500])("fails safely for an unavailable broker (%s)", async (code) => {
  fetchMock.mockResolvedValueOnce(response({ error: "server detail" }, code));
  await expect(beginServerPairing(owner)).rejects.toThrow(
    code === 401 ? "Sign in to Accounts" : code === 429 ? "Too many attempts" : "Could not pair",
  );
});

it("accepts a canonical private HTTP origin for a selfhost", async () => {
  const session = await beginServerPairing(owner);
  fetchMock.mockResolvedValueOnce(
    response(status("approval-required", "http://192.168.1.20:3000")),
  );
  await expect(session.state()).resolves.toEqual(
    status("approval-required", "http://192.168.1.20:3000"),
  );
});

it.each(["failed", "expired"])("does not approve a claim after it becomes %s", async (value) => {
  const session = await beginServerPairing(owner);
  fetchMock.mockResolvedValueOnce(response(status("approval-required")));
  await session.state();
  fetchMock.mockResolvedValueOnce(response(status(value)));
  await session.state();
  const count = fetchMock.mock.calls.length;
  await expect(session.approve(origin)).rejects.toThrow("Could not pair");
  expect(fetchMock).toHaveBeenCalledTimes(count);
});
