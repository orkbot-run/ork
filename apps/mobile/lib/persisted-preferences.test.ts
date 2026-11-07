// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  raw: "off",
  get: vi.fn<() => Promise<string | null>>(),
  set: vi.fn<(key: string, raw: string) => Promise<void>>(),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: () => state.get(),
  setItemAsync: (key: string, raw: string) => state.set(key, raw),
}));
beforeEach(() => {
  vi.resetModules();
  state.raw = "off";
  state.get.mockReset().mockImplementation(async () => state.raw);
  state.set.mockReset().mockImplementation(async (_key, raw) => {
    state.raw = raw;
  });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cases = [
  {
    name: "remote images",
    load: async () => {
      const m = await import("./remote-images-preference");
      return {
        load: m.loadRemoteImagesPreference,
        save: m.setRemoteImagesPreference,
        get: m.getCachedRemoteImagesEnabled,
      };
    },
  },
  {
    name: "streaming",
    load: async () => {
      const m = await import("./response-streaming");
      return {
        load: m.loadResponseStreamingPreference,
        save: m.setResponseStreamingPreference,
        get: m.getCachedResponseStreamingEnabled,
      };
    },
  },
];

it.each(cases)(
  "keeps the newer $name choice when an earlier SecureStore read finishes late",
  async (spec) => {
    const store = await spec.load();
    const read = deferred<string | null>();
    state.get.mockImplementationOnce(() => read.promise);
    const loading = store.load();
    await Promise.resolve();
    await store.save("on");
    read.resolve("off");
    expect(await loading).toBe("on");
    expect(store.get()).toBe(true);
  },
);

it.each(cases)(
  "persists $name writes in choice order and waits for pending writes before reloading",
  async (spec) => {
    const store = await spec.load();
    const first = deferred<void>();
    state.set.mockImplementationOnce(async (_key, raw) => {
      await first.promise;
      state.raw = raw;
    });
    const a = store.save("on");
    await Promise.resolve();
    const b = store.save("off");
    const loading = store.load();
    expect(store.get()).toBe(false);
    first.resolve();
    await Promise.all([a, b]);
    expect(await loading).toBe("off");
    expect(state.raw).toBe("off");
  },
);

it.each(cases)(
  "waits for a single pending $name write before reading SecureStore",
  async (spec) => {
    const store = await spec.load();
    const gate = deferred<void>();
    state.set.mockImplementationOnce(async (_key, raw) => {
      await gate.promise;
      state.raw = raw;
    });
    const saving = store.save("on");
    const loading = store.load();
    await Promise.resolve();
    expect(state.get).not.toHaveBeenCalled();
    expect(store.get()).toBe(true);
    gate.resolve();
    await saving;
    expect(await loading).toBe("on");
    expect(state.get).toHaveBeenCalledOnce();
    expect(state.raw).toBe("on");
  },
);

it.each(cases)(
  "keeps $name memory through unavailable SecureStore without rejecting the local choice",
  async (spec) => {
    const store = await spec.load();
    state.get.mockRejectedValue(new Error("blocked"));
    expect(await store.load()).toBe("off");
    state.set.mockRejectedValue(new Error("blocked"));
    expect(await store.save("on")).toBe("on");
    expect(store.get()).toBe(true);
    expect(await store.load()).toBe("on");
  },
);
