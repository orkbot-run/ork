// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { PrismaClient } from "@orkbot/db";
import { describe, expect, it, vi } from "vitest";
import { credentialDigest } from "./credential-digest.js";
import { PrismaPushTokenStore } from "./push-token-store.js";

type Registration = {
  userId: string;
  sessionId: string;
  tokenDigest: string;
  ciphertext: string;
  presentation?: string | null;
  updatedAt: Date;
};

function fixture() {
  const rows = new Map<string, Registration>();
  const matches = (row: Registration, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "OR")
        return (value as Record<string, unknown>[]).some((part) => matches(row, part));
      if (value && typeof value === "object" && "not" in value)
        return row[key as keyof Registration] !== value.not;
      return row[key as keyof Registration] === value;
    });
  const registrations = {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...rows.values()].filter((row) => matches(row, where)),
    ),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...rows.values()].filter((row) => matches(row, where)).at(-1),
    ),
    upsert: vi.fn(async ({ create }: { create: Omit<Registration, "updatedAt"> }) => {
      rows.set(create.tokenDigest, { ...create, updatedAt: new Date() });
    }),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      for (const [key, row] of rows) if (matches(row, where)) rows.delete(key);
      return { count: 1 };
    }),
  };
  const tx = {
    pushRegistration: registrations,
    pushToken: { upsert: vi.fn(), deleteMany: vi.fn() },
    callPushDevice: { deleteMany: vi.fn() },
    $queryRaw: vi.fn(async () => [{ id: "session" }]),
  };
  const prisma = {
    ...tx,
    $transaction: async (operation: (value: typeof tx) => unknown) => operation(tx),
  } as unknown as PrismaClient;
  return { store: new PrismaPushTokenStore(prisma, "offline-push-fixture-key"), rows, tx };
}

describe("message push registrations", () => {
  it("encrypts and lists independent devices while rotating just one session", async () => {
    const { store, rows } = fixture();
    await store.save("owner", "first-token", "phone", "android_sender");
    await store.save("owner", "second-token", "tablet");
    expect(await store.list("owner")).toHaveLength(2);
    expect(await store.list("someone-else")).toEqual([]);
    for (const row of rows.values()) {
      expect(row.ciphertext).not.toContain("token");
      expect(row.tokenDigest).not.toBe(row.ciphertext);
    }
    await store.save("owner", "rotated-token", "phone");
    expect((await store.list("owner")).map((row) => row.token).sort()).toEqual([
      "rotated-token",
      "second-token",
    ]);
    await store.remove("owner", credentialDigest("first-token"));
    expect(await store.list("owner")).toHaveLength(2);
  });

  it("ends one session and retains the other registration and legacy worker view", async () => {
    const { store, tx } = fixture();
    await store.save("owner", "phone-token", "phone");
    await store.save("owner", "tablet-token", "tablet");
    await store.endSession("owner", "phone");
    expect(await store.list("owner")).toEqual([{ token: "tablet-token", sessionId: "tablet" }]);
    expect(tx.pushToken.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          sessionId: "tablet",
          tokenDigest: credentialDigest("tablet-token"),
        }),
      }),
    );
  });
});
