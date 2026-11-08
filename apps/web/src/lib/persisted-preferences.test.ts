// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Preference = {
  get: () => unknown;
  set: () => unknown;
  subscribe: (listener: () => void) => () => void;
};
const cases = [
  {
    name: "remote images",
    key: "orkbot.loadRemoteImages",
    raw: " ON ",
    value: "on",
    fallback: "off",
    load: async (): Promise<Preference> => {
      const m = await import("./remote-images-preference");
      return {
        get: m.getRemoteImagesPreference,
        set: () => m.setRemoteImagesPreference("off"),
        subscribe: m.subscribeRemoteImages,
      };
    },
  },
  {
    name: "streaming",
    key: "orkbot.responseStreaming",
    raw: " ON ",
    value: "on",
    fallback: "off",
    load: async (): Promise<Preference> => {
      const m = await import("./response-streaming");
      return {
        get: m.getResponseStreamingPreference,
        set: () => m.setResponseStreamingPreference("off"),
        subscribe: m.subscribeResponseStreaming,
      };
    },
  },
  {
    name: "tools",
    key: "orkbot.showToolActivity",
    raw: " ON ",
    value: "on",
    fallback: "off",
    load: async (): Promise<Preference> => {
      const m = await import("./tool-activity-preference");
      return {
        get: m.getToolActivityPreference,
        set: () => m.setToolActivityPreference("off"),
        subscribe: m.subscribeToolActivity,
      };
    },
  },
  {
    name: "sidebar",
    key: "orkbot.botsSidebarDensity",
    raw: " COMPACT ",
    value: "compact",
    fallback: "comfortable",
    load: async (): Promise<Preference> => {
      const m = await import("./bots-sidebar-density-pref");
      return {
        get: m.getBotsSidebarDensity,
        set: () => m.setBotsSidebarDensity("comfortable"),
        subscribe: m.subscribeBotsSidebarDensity,
      };
    },
  },
  {
    name: "Enter",
    key: "orkbot.runposerEnterToSend",
    raw: " OFF ",
    value: false,
    fallback: true,
    load: async (): Promise<Preference> => {
      const m = await import("./composer-enter-to-send-pref");
      return {
        get: m.getComposerEnterToSend,
        set: () => m.setComposerEnterToSend(true),
        subscribe: m.subscribeComposerEnterToSend,
      };
    },
  },
];
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(cases)(
  "updates $name from another window, filters unrelated stores, and clears without echoing writes",
  async (spec) => {
    const store = await spec.load();
    store.set();
    const listener = vi.fn();
    cleanup.push(store.subscribe(listener));
    const write = vi.spyOn(Storage.prototype, "setItem");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "another-key",
        newValue: spec.raw,
        storageArea: localStorage,
      }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: spec.key,
        newValue: spec.raw,
        storageArea: sessionStorage,
      }),
    );
    expect(listener).not.toHaveBeenCalled();
    localStorage.setItem(spec.key, spec.raw);
    write.mockClear();
    window.dispatchEvent(
      new StorageEvent("storage", { key: spec.key, newValue: spec.raw, storageArea: localStorage }),
    );
    expect(store.get()).toBe(spec.value);
    expect(listener).toHaveBeenCalledOnce();
    localStorage.clear();
    window.dispatchEvent(
      new StorageEvent("storage", { key: null, newValue: null, storageArea: localStorage }),
    );
    expect(store.get()).toBe(spec.fallback);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
  },
);

it.each(cases)("disconnects $name and catches up changes while unsubscribed", async (spec) => {
  const store = await spec.load();
  store.set();
  const removed = vi.spyOn(window, "removeEventListener");
  const listener = vi.fn();
  const stop = store.subscribe(listener);
  stop();
  localStorage.setItem(spec.key, spec.raw);
  window.dispatchEvent(
    new StorageEvent("storage", { key: spec.key, newValue: spec.raw, storageArea: localStorage }),
  );
  expect(listener).not.toHaveBeenCalled();
  const next = vi.fn();
  cleanup.push(store.subscribe(next));
  expect(store.get()).toBe(spec.value);
  expect(removed).toHaveBeenCalledWith("storage", expect.any(Function));
});

it.each(["key", "clear"])(
  "does not replace a newer local choice with a delayed %s storage event",
  async (kind) => {
    const { setRemoteImagesPreference, getRemoteImagesEnabled, subscribeRemoteImages } =
      await import("./remote-images-preference");
    const delayed = new StorageEvent("storage", {
      key: kind === "key" ? "orkbot.loadRemoteImages" : null,
      newValue: kind === "key" ? "off" : null,
      storageArea: localStorage,
    });
    cleanup.push(subscribeRemoteImages(() => {}));
    setRemoteImagesPreference("on");
    window.dispatchEvent(delayed);
    expect(getRemoteImagesEnabled()).toBe(true);
    expect(localStorage.getItem("orkbot.loadRemoteImages")).toBe("on");
  },
);

it.each(cases)(
  "retains the saved $name memory when the storage getter becomes unavailable on resubscribe",
  async (spec) => {
    localStorage.setItem(spec.key, spec.raw);
    const store = await spec.load();
    const stop = store.subscribe(() => {});
    expect(store.get()).toBe(spec.value);
    stop();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      cleanup.push(store.subscribe(() => {}));
      expect(store.get()).toBe(spec.value);
    } finally {
      Object.defineProperty(globalThis, "localStorage", descriptor);
    }
  },
);

it("keeps a local unsaved choice when the storage getter is blocked", async () => {
  const { setRemoteImagesPreference, getRemoteImagesEnabled, subscribeRemoteImages } = await import(
    "./remote-images-preference"
  );
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  try {
    const stop = subscribeRemoteImages(() => {});
    cleanup.push(stop);
    expect(getRemoteImagesEnabled()).toBe(false);
    expect(() => setRemoteImagesPreference("on")).not.toThrow();
    expect(getRemoteImagesEnabled()).toBe(true);
  } finally {
    Object.defineProperty(globalThis, "localStorage", descriptor);
  }
});
