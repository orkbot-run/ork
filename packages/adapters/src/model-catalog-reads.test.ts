// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { SecretStoreUnavailableError } from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import { describe, expect, it, vi } from "vitest";
import { createModelCatalogReads } from "./model-catalog-reads.js";
import { loadStoredModelSecret } from "./model-selection.js";
import { ProviderCatalogCache, providerLiveListsModel } from "./pi-live-catalog.js";
import { listPiCatalog } from "./pi-models.js";

function fixture() {
  const records = [
    { id: "secret-a", ciphertext: "version-a", userId: "user-a", spaceId: null },
    { id: "secret-b", ciphertext: "version-b", userId: "user-a", spaceId: null },
    { id: "secret-other", ciphertext: "private", userId: "user-b", spaceId: null },
    { id: "secret-space", ciphertext: "private-space", userId: "user-a", spaceId: "space-a" },
  ];
  const selected = [{ modelProvider: "openai", modelId: "gpt-future-live-chat" }];
  const prisma = {
    secret: {
      findMany: vi.fn(async ({ where }) =>
        records
          .filter(
            (row) =>
              where.id.in.includes(row.id) &&
              row.userId === where.userId &&
              row.spaceId === where.spaceId,
          )
          .map(({ id, ciphertext }) => ({ id, ciphertext })),
      ),
      findFirst: vi.fn(),
    },
    userModelPreference: { findMany: vi.fn(async () => []) },
    bot: { findMany: vi.fn(async () => selected.slice()) },
    routine: { findMany: vi.fn(async () => []) },
    userModelRoleChoice: { findMany: vi.fn(async () => []) },
    spaceModelRoleChoice: { findMany: vi.fn(async () => []) },
    deploymentSettings: { findFirst: vi.fn(async () => null) },
  };
  const load = vi.fn(async (ciphertext: string) => `key-${ciphertext}`);
  const db = prisma as unknown as PrismaClient;
  return {
    records,
    selected,
    prisma,
    db,
    load,
    reads: () => createModelCatalogReads(db, { load }, "user-a"),
  };
}

describe("model catalog request reads", () => {
  it("batches and shares concurrent row reads, retaining the account-wide owner predicate", async () => {
    const { prisma, reads } = fixture();
    const request = reads();
    const [first, second] = await Promise.all([
      request.secrets("user-a", [
        "secret-a",
        "secret-b",
        "secret-a",
        "secret-other",
        "secret-space",
      ]),
      request.secrets("user-a", ["secret-b", "secret-other"]),
    ]);
    expect(first).toEqual([
      { id: "secret-a", ciphertext: "version-a" },
      { id: "secret-b", ciphertext: "version-b" },
    ]);
    expect(second).toEqual([{ id: "secret-b", ciphertext: "version-b" }]);
    expect(prisma.secret.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.secret.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["secret-a", "secret-b", "secret-other", "secret-space"] },
        userId: "user-a",
        spaceId: null,
      },
      select: { id: true, ciphertext: true },
    });
    await expect(request.secrets("user-b", ["secret-other"])).rejects.toThrow("scope changed");
    expect(() => request.selections("user-b")).toThrow("scope changed");
    expect(prisma.secret.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.bot.findMany).not.toHaveBeenCalled();
  });

  it("shares pending decryption and missing rows through the real auth reader", async () => {
    const { prisma, db, load, reads } = fixture();
    const request = reads();
    const results = await Promise.all(
      ["secret-a", "secret-a", "missing", "missing"].map((id) =>
        loadStoredModelSecret(db, { load }, "user-a", id, request),
      ),
    );
    expect(results).toEqual([
      { status: "loaded", ciphertext: "version-a", plaintext: "key-version-a" },
      { status: "loaded", ciphertext: "version-a", plaintext: "key-version-a" },
      { status: "missing" },
      { status: "missing" },
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(prisma.secret.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.secret.findFirst).not.toHaveBeenCalled();
  });

  it("keeps ciphertext revisions and record identities distinct", async () => {
    const { load, reads } = fixture();
    const { secretStore } = reads();
    await Promise.all([
      secretStore.load("version-a", "secret-a"),
      secretStore.load("version-a", "secret-a"),
      secretStore.load("version-new", "secret-a"),
      secretStore.load("version-a", "secret-b"),
    ]);
    expect(load).toHaveBeenCalledTimes(3);
    // Structured contexts carry their own cancellation signal and are never memoized.
    const context = { recordId: "secret-a", signal: new AbortController().signal };
    await secretStore.load("version-a", context);
    expect(load).toHaveBeenLastCalledWith("version-a", context);
  });

  it.each([false, true])(
    "shares failed loads for one request but retries in the next (outage=%s)",
    async (outage) => {
      const { db, load, reads } = fixture();
      const failure = outage ? new SecretStoreUnavailableError() : new Error("unreadable fixture");
      load.mockRejectedValue(failure);
      const request = reads();
      const results = await Promise.allSettled([
        loadStoredModelSecret(db, { load }, "user-a", "secret-a", request),
        loadStoredModelSecret(db, { load }, "user-a", "secret-a", request),
      ]);
      if (outage) {
        expect(results).toEqual([
          { status: "rejected", reason: failure },
          { status: "rejected", reason: failure },
        ]);
      } else {
        expect(results).toEqual([
          { status: "fulfilled", value: { status: "unreadable", ciphertext: "version-a" } },
          { status: "fulfilled", value: { status: "unreadable", ciphertext: "version-a" } },
        ]);
      }
      expect(load).toHaveBeenCalledTimes(1);
      load.mockResolvedValue("new-key");
      await expect(
        loadStoredModelSecret(db, { load }, "user-a", "secret-a", reads()),
      ).resolves.toMatchObject({
        status: "loaded",
        plaintext: "new-key",
      });
      expect(load).toHaveBeenCalledTimes(2);
    },
  );

  it("shares saved-choice reads across concurrent retired-model checks and rereads the next request", async () => {
    const { prisma, db, selected, load, reads } = fixture();
    const bundled = listPiCatalog().filter((entry) => entry.provider === "openai");
    const cache = new ProviderCatalogCache({
      enabled: true,
      probe: vi.fn(async () => bundled.map((entry) => entry.id)),
    });
    const request = reads();
    const check = (id: string, scope = request) =>
      providerLiveListsModel(
        db,
        { load },
        "user-a",
        id,
        "openai",
        "gpt-future-live-chat",
        cache,
        scope,
      );
    await expect(
      Promise.all([check("secret-a"), check("secret-b"), check("secret-a")]),
    ).resolves.toEqual([true, true, true]);
    for (const delegate of [
      prisma.userModelPreference,
      prisma.bot,
      prisma.routine,
      prisma.userModelRoleChoice,
      prisma.spaceModelRoleChoice,
    ]) {
      expect(delegate.findMany).toHaveBeenCalledTimes(1);
    }
    expect(prisma.deploymentSettings.findFirst).toHaveBeenCalledTimes(1);
    selected.length = 0;
    await expect(check("secret-a", reads())).resolves.toBe(false);
    expect(prisma.bot.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.secret.findFirst).not.toHaveBeenCalled();
  });

  it("does not retain deleted, newly owned or rotated secrets in another request", async () => {
    const { db, load, reads, records } = fixture();
    await expect(
      loadStoredModelSecret(db, { load }, "user-a", "secret-a", reads()),
    ).resolves.toMatchObject({ plaintext: "key-version-a" });
    records[0]!.ciphertext = "version-rotated";
    await expect(
      loadStoredModelSecret(db, { load }, "user-a", "secret-a", reads()),
    ).resolves.toMatchObject({ plaintext: "key-version-rotated" });
    records[0]!.userId = "user-b";
    await expect(
      loadStoredModelSecret(db, { load }, "user-a", "secret-a", reads()),
    ).resolves.toEqual({ status: "missing" });
    records.splice(1, 1);
    await expect(
      loadStoredModelSecret(db, { load }, "user-a", "secret-b", reads()),
    ).resolves.toEqual({ status: "missing" });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
