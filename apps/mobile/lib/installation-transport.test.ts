// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
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
