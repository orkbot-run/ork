// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  descriptors: [] as string[],
  available: true,
  stage: vi.fn(),
  sign: vi.fn(),
  activate: vi.fn(),
  forget: vi.fn(),
  wipe: vi.fn(),
  set: vi.fn(),
}));
vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: () =>
    state.available
      ? {
          stagePersonalKey: state.stage,
          signPersonalProof: state.sign,
          activatePersonalKey: state.activate,
          personalCredentials: async () => state.descriptors,
          forgetPersonalKey: state.forget,
          forgetAllPersonalKeys: state.wipe,
        }
      : null,
}));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: async (key: string) => state.storage.get(key) ?? null,
  deleteItemAsync: async (key: string) => {
    state.storage.delete(key);
  },
  setItemAsync: (...args: unknown[]) => state.set(...args),
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target = {
  organizationId: id(1),
  serverId: id(2),
  workspaceId: id(3),
  bindingVersion: 1,
  keyFingerprint: "a".repeat(64),
};
const account = JSON.stringify(["https://accounts.example.test", "owner"]);
const origin = "https://server.example.test";
const signedOut = "orkbot.personal.signed-out-v1";
beforeEach(() => {
  vi.resetModules();
  state.storage.clear();
  state.descriptors = [];
  state.available = true;
  state.stage.mockReset().mockResolvedValue({ id: id(4), publicKey: "publicSPKI" });
  state.sign.mockReset().mockResolvedValue("signature");
  state.forget.mockReset().mockResolvedValue(undefined);
  state.wipe.mockReset().mockImplementation(async () => {
    state.descriptors = [];
  });
  state.activate
    .mockReset()
    .mockImplementation(async (_scope: string, _id: string, descriptor: string) => {
      state.descriptors = [descriptor];
    });
  state.set.mockReset().mockImplementation(async (key: string, value: string) => {
    state.storage.set(key, value);
  });
});
it("activates only public metadata and locates the exact account, installation and workspace", async () => {
  const device = await import("./personal-device");
  const staged = (await device.stagePersonalDevice(account, origin, target))!;
  await device.activatePersonalDevice(staged, () => true);
  expect(await device.personalCredential(account, origin, target)).toEqual(staged.credential);
  expect(
    await device.personalCredential(account, origin, { ...target, bindingVersion: 2 }),
  ).toBeNull();
  expect(await device.personalCredential(account, "https://other.example.test", target)).toBeNull();
  expect(
    await device.personalCredential(
      JSON.stringify(["https://accounts.example.test", "another"]),
      origin,
      target,
    ),
  ).toBeNull();
  expect(state.descriptors[0]).not.toContain("private");
  expect(state.stage).toHaveBeenCalledWith(staged.credential.scope, JSON.stringify(target));
});
it("does not create an offline credential in an older binary", async () => {
  state.available = false;
  const device = await import("./personal-device");
  expect(await device.stagePersonalDevice(account, origin, target)).toBeNull();
  expect(await device.personalCredential(account, origin, target)).toBeNull();
  expect(state.stage).not.toHaveBeenCalled();
});
it("refuses metadata with a substituted account, target, origin or extra properties", async () => {
  const device = await import("./personal-device");
  const { credential } = (await device.stagePersonalDevice(account, origin, target))!;
  for (const patch of [
    { account: "[]" },
    { origin: origin + "/path" },
    { origin: "http://server.example.test" },
    { target: { ...target, workspaceId: id(9) } },
    { privateKey: "forbidden" },
    { version: 2 },
  ]) {
    expect(() =>
      device.parsePersonalCredential(JSON.stringify({ ...credential, ...patch })),
    ).toThrow();
  }
});
it("invalidates a signature synchronously on logout even when the native operation is pending", async () => {
  const device = await import("./personal-device");
  const staged = (await device.stagePersonalDevice(account, origin, target))!;
  let release!: (value: string) => void;
  state.sign.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const signing = device.signPersonalDevice(staged.credential, "message", staged.epoch);
  const rejected = expect(signing).rejects.toThrow("Could not continue");
  await vi.waitFor(() => expect(state.sign).toHaveBeenCalled());
  const logout = device.signOutPersonalDevices();
  release("signature");
  await rejected;
  await logout;
  expect(state.wipe).toHaveBeenCalledOnce();
  expect(state.storage.get(signedOut)).toBe("1");
});
it("does not let a late activation undo logout", async () => {
  const device = await import("./personal-device");
  const staged = (await device.stagePersonalDevice(account, origin, target))!;
  let release!: () => void;
  state.activate.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const activation = device.activatePersonalDevice(staged, () => true);
  const rejected = expect(activation).rejects.toThrow("Could not continue");
  await vi.waitFor(() => expect(state.activate).toHaveBeenCalled());
  const logout = device.signOutPersonalDevices();
  release();
  await rejected;
  await logout;
  expect(state.forget).toHaveBeenCalledWith(staged.credential.scope, staged.device.id);
  expect(await device.personalCredential(account, origin, target)).toBeNull();
  expect(state.storage.get(signedOut)).toBe("1");
});
it("keeps a durable denial after native key deletion fails and the process restarts", async () => {
  let device = await import("./personal-device");
  const staged = (await device.stagePersonalDevice(account, origin, target))!;
  await device.activatePersonalDevice(staged, () => true);
  state.wipe.mockRejectedValue(new Error("Keystore locked"));
  await expect(device.signOutPersonalDevices()).rejects.toThrow("Keystore locked");
  vi.resetModules();
  device = await import("./personal-device");
  expect(await device.personalCredential(account, origin, target)).toBeNull();
});
it("still attempts the native wipe when writing the denial marker fails", async () => {
  const device = await import("./personal-device");
  state.set.mockRejectedValue(new Error("Secure storage failed"));
  await expect(device.signOutPersonalDevices()).rejects.toThrow("Secure storage failed");
  expect(state.wipe).toHaveBeenCalledOnce();
  expect(await device.personalCredential(account, origin, target)).toBeNull();
});
it("allows a fresh verified activation after logout without restoring old keys", async () => {
  const device = await import("./personal-device");
  await device.signOutPersonalDevices();
  const staged = (await device.stagePersonalDevice(account, origin, target))!;
  await device.activatePersonalDevice(staged, () => true);
  expect(state.storage.has(signedOut)).toBe(false);
  expect(await device.personalCredential(account, origin, target)).toEqual(staged.credential);
});
