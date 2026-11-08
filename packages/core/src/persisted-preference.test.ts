// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it, vi } from "vitest";
import { createPersistedPreference } from "./persisted-preference.js";

const normalize = (raw: string | null | undefined) => (raw === "on" ? "on" : "off");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("preserves memory after blocked reads/writes and makes sync writes visible before notifying", () => {
  let raw: string | null = null;
  const store = createPersistedPreference({
    normalize,
    read: () => raw,
    write: (next) => {
      raw = next;
      return true;
    },
  });
  const listener = vi.fn(() => expect(raw).toBe(store.get()));
  const unsubscribe = store.subscribe(listener);
  expect(store.get()).toBe("off");
  store.set("on");
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
  store.set("off", () => {
    throw new Error("blocked");
  });
  expect(store.get()).toBe("off");
  expect(
    store.read(() => {
      throw new Error("blocked");
    }),
  ).toBe("off");
});

it("connects external changes once, disconnects last subscriber and refreshes a missed clean write", () => {
  let raw = "off";
  let changed!: (raw: string | null) => void;
  const detach = vi.fn();
  const connect = vi.fn((callback: typeof changed) => {
    changed = callback;
    return detach;
  });
  const write = vi.fn((next: string) => {
    raw = next;
    return true;
  });
  const store = createPersistedPreference({ normalize, read: () => raw, write, listen: connect });
  const first = vi.fn();
  const removeA = store.subscribe(first);
  const removeB = store.subscribe(() => {});
  expect(connect).toHaveBeenCalledOnce();
  changed("on");
  expect(store.get()).toBe("on");
  expect(write).not.toHaveBeenCalled();
  removeA();
  expect(detach).not.toHaveBeenCalled();
  removeB();
  expect(detach).toHaveBeenCalledOnce();
  const last = vi.fn();
  const stop = store.subscribe(last);
  expect(store.get()).toBe("off");
  expect(last).toHaveBeenCalledOnce();
  stop();
});

it("does not replace a failed local write with older readable storage on resubscribe", () => {
  const store = createPersistedPreference({
    normalize,
    read: () => "off",
    write: () => false,
    listen: () => () => {},
  });
  store.set("on");
  const stop = store.subscribe(() => {});
  expect(store.get()).toBe("on");
  stop();
});

it("rejects stale native loads after a newer choice and returns that choice", async () => {
  const read = deferred<string | null>();
  const store = createPersistedPreference({ normalize });
  const loading = store.load(() => read.promise);
  await Promise.resolve();
  await store.save("on", async () => {});
  read.resolve("off");
  expect(await loading).toBe("on");
});

it("keeps the latest native read when reads settle out of order", async () => {
  const first = deferred<string | null>();
  const second = deferred<string | null>();
  const store = createPersistedPreference({ normalize });
  const a = store.load(() => first.promise);
  await Promise.resolve();
  const b = store.load(() => second.promise);
  second.resolve("on");
  await b;
  first.resolve("off");
  expect(await a).toBe("on");
});

it("serializes one preference's writes without blocking another and recovers after failure", async () => {
  const first = deferred<void>();
  const writes: string[] = [];
  const store = createPersistedPreference({ normalize });
  const a = store.save("on", async (raw) => {
    await first.promise;
    writes.push(raw);
  });
  const b = store.save("off", async (raw) => {
    writes.push(raw);
    throw new Error("blocked");
  });
  expect(store.get()).toBe("off");
  const other = createPersistedPreference({ normalize });
  await other.save("on", async (raw) => {
    writes.push(`other:${raw}`);
  });
  expect(writes).toEqual(["other:on"]);
  first.resolve();
  await Promise.all([a, b]);
  await store.save("on", async (raw) => {
    writes.push(raw);
  });
  expect(writes).toEqual(["other:on", "on", "off", "on"]);
});

it("admits writes before subscriber reentry and waits for persistence before a new load", async () => {
  let raw = "off";
  const store = createPersistedPreference({ normalize });
  const gate = deferred<void>();
  let reentered = false;
  let later!: Promise<string>;
  const stop = store.subscribe(() => {
    if (reentered) return;
    reentered = true;
    later = store.save("off", async (next) => {
      raw = next;
    });
  });
  const first = store.save("on", async (next) => {
    await gate.promise;
    raw = next;
  });
  const load = store.load(async () => raw);
  gate.resolve();
  await Promise.all([first, later, load]);
  expect(raw).toBe("off");
  expect(store.get()).toBe("off");
  stop();
});
