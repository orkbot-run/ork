// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authorization: {
    issuer: "https://accounts.example.test",
    subject: "user-one",
    accessToken: "central-token",
  },
  available: true,
  begin: vi.fn(async () => "native-session"),
  select: vi.fn(
    async (_session: string, _revision: number, _target: string): Promise<void> => undefined,
  ),
  end: vi.fn(async (_session: string) => undefined),
  open: vi.fn(
    async (_session: string, _revision: number, _id: string, _input: string) => undefined,
  ),
  head: vi.fn(async () => ({ status: 204, headers: [] })),
  start: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
}));
vi.mock("./accounts", () => ({ accountsAuthorization: async () => state.authorization }));
vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: () => (state.available ? state : null),
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "10000000-0000-4000-8000-000000000008" }));
const account = JSON.stringify(["https://accounts.example.test", "user-one"]);
const origin = "https://server.example.test";
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target = {
  organizationId: id(1),
  serverId: id(2),
  workspaceId: id(3),
  bindingVersion: 1,
  keyFingerprint: "a".repeat(64),
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.available = true;
});
afterEach(() => vi.unstubAllGlobals());

it("retires a workspace session only through its exact current account, admission and installation pin", async () => {
  const {
    selectInstallationTransport,
    installationRevocationScope,
    fetchInstallationRevocation,
    invalidateInstallationTransport,
  } = await import("./installation-transport");
  const fallback = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fallback);
  await selectInstallationTransport(account, origin, target);
  const captured = installationRevocationScope(origin)!;
  const init = { method: "POST", headers: { authorization: "Bearer retired-product-session" } };
  invalidateInstallationTransport();
  await expect(
    fetchInstallationRevocation(`${origin}/api/auth/sign-out`, init, captured),
  ).rejects.toThrow("Native connection changed");
  for (const changed of [
    { ...target, workspaceId: id(7) },
    { ...target, bindingVersion: 2 },
    { ...target, keyFingerprint: "b".repeat(64) },
  ]) {
    await selectInstallationTransport(account, origin, changed);
    await expect(
      fetchInstallationRevocation(`${origin}/api/auth/sign-out`, init, captured),
    ).rejects.toThrow("Native connection changed");
  }
  await selectInstallationTransport(
    JSON.stringify(["https://accounts.example.test", "other-user"]),
    origin,
    target,
  );
  await expect(
    fetchInstallationRevocation(`${origin}/api/auth/sign-out`, init, captured),
  ).rejects.toThrow("Native connection changed");
  expect(state.open).not.toHaveBeenCalled();
  expect(fallback).not.toHaveBeenCalled();
  await selectInstallationTransport(account, origin, target);
  expect(
    (await fetchInstallationRevocation(`${origin}/api/auth/sign-out`, init, captured)).status,
  ).toBe(204);
  expect(state.open).toHaveBeenCalledOnce();
  expect(JSON.parse(state.open.mock.calls[0]![3]).headers).toEqual([
    { name: "authorization", value: "Bearer retired-product-session" },
  ]);
  expect(fallback).not.toHaveBeenCalled();
});

it("never sends a reserved installation origin through ordinary HTTP, including before selection", async () => {
  const { fetchInstallation } = await import("./installation-transport");
  const fallback = vi.fn<typeof fetch>();
  await expect(
    fetchInstallation(`https://${target.serverId}.installation.ork.invalid/rpc/me`, {}, fallback),
  ).rejects.toThrow("Native connection changed");
  expect(fallback).not.toHaveBeenCalled();
});

it("obtains one relay capability per request and keeps Accounts and product bearers on separate channels", async () => {
  const { selectInstallationTransport, fetchInstallation } = await import(
    "./installation-transport"
  );
  const origin = `https://${target.serverId}.installation.ork.invalid`;
  const relay = { origin: "https://relay.example.test" };
  let count = 0;
  const central = vi.fn<typeof fetch>(async () =>
    Response.json({
      grant: `relay-ticket-${++count}`,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      relayOrigin: relay.origin,
    }),
  );
  vi.stubGlobal("fetch", central);
  const fallback = vi.fn<typeof fetch>();
  await selectInstallationTransport(account, origin, target, relay);
  for (let n = 0; n < 2; n++)
    await fetchInstallation(
      `${origin}/api/events`,
      { headers: { authorization: "Bearer product-token" } },
      fallback,
    );
  expect(central).toHaveBeenCalledTimes(2);
  expect(fallback).not.toHaveBeenCalled();
  for (const [url, input] of central.mock.calls) {
    expect(url).toBe("https://accounts.example.test/api/identity/v2/relay-tickets");
    expect(new Headers(input?.headers).get("authorization")).toBe("Bearer central-token");
    expect(input?.body).not.toContain("product-token");
  }
  expect(state.open.mock.calls.map((call) => JSON.parse(call[3]).relayTicket)).toEqual([
    "relay-ticket-1",
    "relay-ticket-2",
  ]);
  for (const call of state.open.mock.calls) {
    const input = JSON.parse(call[3]);
    expect(input.headers).toEqual([{ name: "authorization", value: "Bearer product-token" }]);
    expect(call[3]).not.toContain("central-token");
  }
});

it("rejects a changed relay and a late ticket after logout before opening the native request", async () => {
  const { selectInstallationTransport, fetchInstallation, invalidateInstallationTransport } =
    await import("./installation-transport");
  const origin = `https://${target.serverId}.installation.ork.invalid`;
  const relay = { origin: "https://relay.example.test" };
  await selectInstallationTransport(account, origin, target, relay);
  const value = {
    grant: "short-ticket",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    relayOrigin: "https://other.example.test",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(value)),
  );
  await expect(fetchInstallation(`${origin}/rpc/me`, {})).rejects.toThrow(
    "Native connection changed",
  );
  expect(state.open).not.toHaveBeenCalled();
  let resolve!: (value: Response) => void;
  const response = new Promise<Response>((complete) => {
    resolve = complete;
  });
  const fetcher = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetcher);
  const pending = fetchInstallation(`${origin}/rpc/me`, {});
  const rejected = expect(pending).rejects.toThrow("Native connection changed");
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  invalidateInstallationTransport();
  resolve(Response.json({ ...value, relayOrigin: relay.origin }));
  await rejected;
  expect(state.open).not.toHaveBeenCalled();
});

it("sends product operations through native pinning and Accounts through its separate channel", async () => {
  const { selectInstallationTransport, fetchInstallation } = await import(
    "./installation-transport"
  );
  const fallback = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  await selectInstallationTransport(account, origin, target);
  expect(state.select).toHaveBeenCalledWith(
    "native-session",
    1,
    JSON.stringify({ account, origin, ...target }),
  );
  expect(
    (
      await fetchInstallation(
        `${origin}/api/rpc`,
        { headers: { authorization: "Bearer product" } },
        fallback,
      )
    ).status,
  ).toBe(204);
  expect(fallback).not.toHaveBeenCalled();
  await fetchInstallation(
    "https://accounts.example.test/api/identity/v2/catalog",
    { headers: { authorization: "Bearer central" } },
    fallback,
  );
  expect(fallback).toHaveBeenCalledOnce();
  expect(state.open).toHaveBeenCalledOnce();
  expect(JSON.parse(state.open.mock.calls[0]![3])).toMatchObject({
    headers: [{ name: "authorization", value: "Bearer product" }],
  });
});

it("fences a delayed native selection before it can open a request", async () => {
  const { selectInstallationTransport, fetchInstallation } = await import(
    "./installation-transport"
  );
  let release!: () => void;
  const selected = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.select.mockReturnValueOnce(selected);
  const first = selectInstallationTransport(account, origin, target);
  await vi.waitFor(() => expect(state.select).toHaveBeenCalledOnce());
  const old = fetchInstallation(`${origin}/api/rpc`, {});
  const firstFailure = expect(first).rejects.toThrow("changed");
  const oldFailure = expect(old).rejects.toThrow("changed");
  const second = selectInstallationTransport(account, origin, { ...target, workspaceId: id(4) });
  release();
  await firstFailure;
  await oldFailure;
  await second;
  expect(state.open).not.toHaveBeenCalled();
  expect(state.select.mock.calls[1]?.[1]).toBe(2);
});

it("does not fall back to ordinary fetch after logout or when native support is unavailable", async () => {
  const { selectInstallationTransport, fetchInstallation, invalidateInstallationTransport } =
    await import("./installation-transport");
  const fallback = vi.fn<typeof fetch>();
  await selectInstallationTransport(account, origin, target);
  invalidateInstallationTransport();
  await expect(fetchInstallation(`${origin}/api/files`, {}, fallback)).rejects.toThrow("changed");
  await vi.waitFor(() => expect(state.end).toHaveBeenCalledOnce());
  state.available = false;
  expect(fallback).not.toHaveBeenCalled();
});

it("requires a new native binary when the transport module is missing", async () => {
  state.available = false;
  const { selectInstallationTransport, fetchInstallation } = await import(
    "./installation-transport"
  );
  const fallback = vi.fn<typeof fetch>();
  await expect(selectInstallationTransport(account, origin, target)).rejects.toThrow("Update Ork");
  await expect(fetchInstallation(`${origin}/api/files`, {}, fallback)).rejects.toThrow(
    "Update Ork",
  );
  expect(fallback).not.toHaveBeenCalled();
});

it("refuses pinning the Accounts origin as an installation", async () => {
  const { selectInstallationTransport } = await import("./installation-transport");
  await expect(
    selectInstallationTransport(account, "https://accounts.example.test", target),
  ).rejects.toThrow("Could not continue");
  expect(state.begin).not.toHaveBeenCalled();
});
