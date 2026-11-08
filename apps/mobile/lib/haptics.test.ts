// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  os: "ios",
  state: "active",
  loads: 0,
  gate: undefined as Promise<void> | undefined,
  unavailable: false,
  read: vi.fn(),
  write: vi.fn(),
  selection: vi.fn(),
  android: vi.fn(),
}));
vi.mock("expo-secure-store", () => ({ getItemAsync: fake.read, setItemAsync: fake.write }));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return fake.os;
    },
  },
  AppState: {
    get currentState() {
      return fake.state;
    },
  },
}));
const tick = () => vi.dynamicImportSettled();
beforeEach(() => {
  vi.resetModules();
  fake.os = "ios";
  fake.state = "active";
  fake.loads = 0;
  fake.gate = undefined;
  fake.unavailable = false;
  fake.read.mockReset().mockResolvedValue(null);
  fake.write.mockReset().mockResolvedValue(undefined);
  fake.selection = vi.fn().mockResolvedValue(undefined);
  fake.android = vi.fn().mockResolvedValue(undefined);
  vi.doMock("expo-haptics", async () => {
    fake.loads++;
    if (fake.gate) await fake.gate;
    if (fake.unavailable) throw new Error("native module unavailable");
    return {
      selectionAsync: fake.selection,
      performAndroidHapticsAsync: fake.android,
      AndroidHaptics: { Segment_Tick: "segment-tick" },
    };
  });
});
afterEach(async () => {
  await tick();
});

it("keeps unknown, missing and disabled preferences silent without importing native code", async () => {
  const haptics = await import("./haptics");
  haptics.selectionHaptic();
  expect(haptics.getHapticsEnabled()).toBeUndefined();
  expect(await haptics.loadHapticsEnabled()).toBe(false);
  haptics.selectionHaptic();
  await tick();
  expect(fake.loads).toBe(0);
  expect(fake.selection).not.toHaveBeenCalled();
});
it.each(["ios", "android"])(
  "plays one subtle selection through the %s system API only after opt-in",
  async (os) => {
    fake.os = os;
    const haptics = await import("./haptics");
    await haptics.saveHapticsEnabled(true);
    expect(fake.write).toHaveBeenCalledWith(haptics.HAPTICS_KEY, "1");
    expect(haptics.selectionHaptic()).toBeUndefined();
    await tick();
    expect(os === "ios" ? fake.selection : fake.android).toHaveBeenCalledOnce();
    expect(os === "ios" ? fake.android : fake.selection).not.toHaveBeenCalled();
    if (os === "android") expect(fake.android).toHaveBeenCalledWith("segment-tick");
  },
);
it("restores only the device preference and shares a pending read", async () => {
  fake.read.mockResolvedValue("1");
  const haptics = await import("./haptics");
  await Promise.all([haptics.loadHapticsEnabled(), haptics.loadHapticsEnabled()]);
  expect(fake.read).toHaveBeenCalledTimes(1);
  expect(haptics.getHapticsEnabled()).toBe(true);
});
it("fails closed when preference reading or writing fails, then permits a later explicit save", async () => {
  fake.read.mockRejectedValueOnce(new Error("locked"));
  fake.write.mockRejectedValueOnce(new Error("locked"));
  const haptics = await import("./haptics");
  expect(await haptics.loadHapticsEnabled()).toBe(false);
  await expect(haptics.saveHapticsEnabled(true)).rejects.toThrow("locked");
  haptics.selectionHaptic();
  expect(haptics.getHapticsEnabled()).toBe(false);
  expect(fake.loads).toBe(0);
  await haptics.saveHapticsEnabled(true);
  expect(haptics.getHapticsEnabled()).toBe(true);
});
it("does not let late hydration overwrite an explicit opt-out", async () => {
  let read!: (value: string) => void;
  fake.read.mockReturnValueOnce(
    new Promise((resolve) => {
      read = resolve;
    }),
  );
  const haptics = await import("./haptics");
  const pending = haptics.loadHapticsEnabled();
  await haptics.saveHapticsEnabled(false);
  read("1");
  await pending;
  expect(haptics.getHapticsEnabled()).toBe(false);
});
it("serializes preference writes and leaves feedback off while a choice is unconfirmed", async () => {
  let finish!: () => void;
  fake.write.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const haptics = await import("./haptics");
  const on = haptics.saveHapticsEnabled(true);
  const off = haptics.saveHapticsEnabled(false);
  await tick();
  expect(fake.write).toHaveBeenCalledTimes(1);
  expect(haptics.getHapticsEnabled()).toBe(false);
  haptics.selectionHaptic();
  expect(fake.loads).toBe(0);
  finish();
  await Promise.all([on, off]);
  expect(fake.write.mock.calls.map(([, value]) => value)).toEqual(["1", "0"]);
  expect(haptics.getHapticsEnabled()).toBe(false);
});
it.each(["web", "windows", "macos"])(
  "does not attempt unsupported %s hardware feedback",
  async (os) => {
    fake.os = os;
    const haptics = await import("./haptics");
    await haptics.saveHapticsEnabled(true);
    haptics.selectionHaptic();
    await tick();
    expect(fake.loads).toBe(0);
  },
);
it.each(["opt-out", "background"])("does not replay delayed feedback after %s", async (reason) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fake.gate = gate;
  const haptics = await import("./haptics");
  await haptics.saveHapticsEnabled(true);
  haptics.selectionHaptic();
  if (reason === "opt-out") await haptics.saveHapticsEnabled(false);
  else fake.state = "background";
  release();
  await tick();
  expect(fake.selection).not.toHaveBeenCalled();
});
it.each(["background", "inactive"])(
  "does not load native feedback while already %s",
  async (state) => {
    fake.state = state;
    const haptics = await import("./haptics");
    await haptics.saveHapticsEnabled(true);
    haptics.selectionHaptic();
    await tick();
    expect(fake.loads).toBe(0);
  },
);
it("silently degrades when the native module cannot load", async () => {
  fake.unavailable = true;
  const haptics = await import("./haptics");
  await haptics.saveHapticsEnabled(true);
  haptics.selectionHaptic();
  await tick();
  expect(fake.loads).toBe(1);
  expect(fake.selection).not.toHaveBeenCalled();
});
it("silently tolerates unavailable native APIs and rejected device feedback", async () => {
  fake.selection.mockRejectedValue(new Error("hardware unavailable"));
  const haptics = await import("./haptics");
  await haptics.saveHapticsEnabled(true);
  haptics.selectionHaptic();
  await tick();
  expect(fake.selection).toHaveBeenCalledOnce();
});
