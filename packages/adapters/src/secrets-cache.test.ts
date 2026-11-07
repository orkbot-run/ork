// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type * as NativeCrypto from "node:crypto";
import type { AdapterContext } from "@orkbot/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "./secrets.js";

const derivation = vi.hoisted(() => ({
  calls: 0,
  hold: false,
  pending: [] as Array<(error?: Error) => void>,
}));
vi.mock("node:crypto", async (original) => {
  const native = await original<typeof NativeCrypto>();
  // Control only KDF scheduling/counts here. The conformance suites exercise real scrypt.
  const derive = (secret: string, salt: Buffer) =>
    native.createHash("sha256").update(secret).update(salt).digest();
  return {
    ...native,
    scryptSync: (secret: string, salt: Buffer) => derive(secret, salt),
    scrypt: (
      secret: string,
      salt: Buffer,
      _length: number,
      _options: unknown,
      callback: (error: Error | null, key: Buffer) => void,
    ) => {
      derivation.calls++;
      const finish = (error?: Error) => callback(error ?? null, derive(secret, salt));
      if (derivation.hold) derivation.pending.push(finish);
      else queueMicrotask(finish);
    },
  };
});

const context: AdapterContext = {
  operationId: "cache-test",
  traceId: "cache-test",
  spaceId: "space-a",
  userId: "user-a",
  signal: new AbortController().signal,
};
beforeEach(() => {
  derivation.calls = 0;
  derivation.hold = false;
  derivation.pending = [];
});
const fixture = async (
  store = new EncryptedSecretStore("fake-cache-key"),
  value = "fake secret",
) => ({ store, record: await store.put(value, context, { recordId: "row-a" }), value });
const finishAll = () => {
  for (const finish of derivation.pending.splice(0)) finish();
};

describe("encrypted-store derivation ownership", () => {
  it("derives a repeatedly read salt once while retaining authenticated row binding", async () => {
    const { store, record, value } = await fixture();
    expect(await store.load(record.ref, record.id)).toBe(value);
    expect(await store.load(record.ref, record.id)).toBe(value);
    await expect(store.load(record.ref, "another-row")).rejects.toThrow();
    expect(derivation.calls).toBe(1);
  });

  it("shares the same pending derivation across concurrent reads without sharing caller cancellation", async () => {
    const { store, record, value } = await fixture();
    derivation.hold = true;
    const abort = new AbortController();
    const cancelled = store.load(record.ref, { recordId: record.id, signal: abort.signal });
    const rejected = expect(cancelled).rejects.toThrow();
    const accepted = store.load(record.ref, record.id);
    expect(derivation.calls).toBe(1);
    abort.abort();
    finishAll();
    await rejected;
    expect(await accepted).toBe(value);
    expect(await store.load(record.ref, record.id)).toBe(value);
    expect(derivation.calls).toBe(1);
  });

  it("does not derive for an already cancelled read", async () => {
    const { store, record } = await fixture();
    await expect(
      store.load(record.ref, { recordId: record.id, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(derivation.calls).toBe(0);
  });

  it("keeps different salts and encryption-key owners separate", async () => {
    const a = new EncryptedSecretStore("fake-owner-a");
    const b = new EncryptedSecretStore("fake-owner-b");
    const first = await fixture(a);
    const second = await fixture(a);
    expect(first.record.ref).not.toBe(second.record.ref);
    await a.load(first.record.ref, first.record.id);
    await a.load(second.record.ref, second.record.id);
    await expect(b.load(first.record.ref, first.record.id)).rejects.toThrow();
    expect(derivation.calls).toBe(3);
  });

  it("does not share retained derivations between store instances even with the same encryption key", async () => {
    const { store, record, value } = await fixture();
    const another = new EncryptedSecretStore("fake-cache-key");
    expect(await store.load(record.ref, record.id)).toBe(value);
    expect(await another.load(record.ref, record.id)).toBe(value);
    expect(derivation.calls).toBe(2);
  });

  it("bounds retention to 64 salts and refreshes the least-recently-used order", async () => {
    const store = new EncryptedSecretStore("fake-cache-key");
    const records = await Promise.all(
      Array.from({ length: 65 }, () => store.put("fake secret", context, { recordId: "row-a" })),
    );
    for (const record of records.slice(0, 64)) await store.load(record.ref, record.id);
    await store.load(records[0]!.ref, "row-a");
    await store.load(records[64]!.ref, "row-a");
    expect(derivation.calls).toBe(65);
    await store.load(records[0]!.ref, "row-a");
    expect(derivation.calls).toBe(65);
    await store.load(records[1]!.ref, "row-a");
    expect(derivation.calls).toBe(66);
  });

  it("removes a failed derivation so a later read can retry", async () => {
    const { store, record, value } = await fixture();
    derivation.hold = true;
    const failed = expect(store.load(record.ref, record.id)).rejects.toThrow(
      "fake derivation failure",
    );
    derivation.pending.shift()!(new Error("fake derivation failure"));
    await failed;
    const retry = store.load(record.ref, record.id);
    finishAll();
    expect(await retry).toBe(value);
    expect(derivation.calls).toBe(2);
  });

  it("does not let an evicted rejected promise remove a newer derivation of the same salt", async () => {
    const { store, record, value } = await fixture();
    derivation.hold = true;
    const rejected = expect(store.load(record.ref, record.id)).rejects.toThrow("old failure");
    const old = derivation.pending.shift()!;
    const others = await Promise.all(
      Array.from({ length: 64 }, () => store.put("other fake secret", context)),
    );
    const waiting = Promise.all(others.map((item) => store.load(item.ref, item.id)));
    const replacement = store.load(record.ref, record.id);
    expect(derivation.calls).toBe(66);
    old(new Error("old failure"));
    await rejected;
    const shared = store.load(record.ref, record.id);
    expect(derivation.calls).toBe(66);
    finishAll();
    await waiting;
    expect(await replacement).toBe(value);
    expect(await shared).toBe(value);
  });

  it("drops retention on close and cannot repopulate it from a late completion", async () => {
    const { store, record, value } = await fixture();
    derivation.hold = true;
    const pending = store.load(record.ref, record.id);
    await store.close();
    finishAll();
    expect(await pending).toBe(value);
    derivation.hold = false;
    expect(await store.load(record.ref, record.id)).toBe(value);
    expect(await store.load(record.ref, record.id)).toBe(value);
    expect(derivation.calls).toBe(3);
    await store.start();
    expect(await store.load(record.ref, record.id)).toBe(value);
    expect(await store.load(record.ref, record.id)).toBe(value);
    expect(derivation.calls).toBe(4);
  });
});
