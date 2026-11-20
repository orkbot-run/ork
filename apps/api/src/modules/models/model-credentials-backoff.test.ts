// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { CodexLiveCatalog } from "@orkbot/adapters";
import { releaseUserRoutineAccountBackoffs } from "@orkbot/adapters";
import { beforeEach, expect, it, vi } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { persistModelCredential } from "./model-credentials.js";

vi.mock("@orkbot/adapters", async (original) => ({
  ...(await original<typeof import("@orkbot/adapters")>()),
  defaultCatalogModelId: () => undefined,
  releaseUserRoutineAccountBackoffs: vi.fn(async () => undefined),
}));
vi.mock("@orkbot/db", async (original) => ({
  ...(await original<typeof import("@orkbot/db")>()),
  modelRoleTarget: vi.fn(async () => ({})),
  getModelRole: vi.fn(async () => ({ primary: null, backups: [] })),
  saveModelPreference: vi.fn(async () => undefined),
}));

beforeEach(() => vi.clearAllMocks());

function fixture() {
  const actor = {
    userId: "key-owner",
    spaceId: "space",
    email: "owner@example.test",
    isDeploymentOwner: false,
  };
  const tx = {
    secret: { create: vi.fn(async () => ({ id: "secret" })) },
    userModelCredential: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: "credential",
      })),
    },
  };
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(tx));
  const deps = {
    prisma: { $transaction: transaction },
    secrets: { put: vi.fn(async () => ({ id: "secret", ciphertext: "encrypted" })) },
    env: {},
    providerCatalog: { invalidate: vi.fn() },
    jobs: {},
  } as unknown as RouterDeps;
  const save = () =>
    persistModelCredential(
      deps,
      actor,
      {
        provider: "openrouter",
        credentialId: null,
        plaintext: "fixture-key",
        makeDefault: false,
      },
      {} as CodexLiveCatalog,
    );
  return { deps, transaction, save };
}

it("releases the credential owner's routine holds after the credential commits", async () => {
  const { deps, save, transaction } = fixture();
  await expect(save()).resolves.toMatchObject({ id: "credential" });
  expect(releaseUserRoutineAccountBackoffs).toHaveBeenCalledExactlyOnceWith(deps, "key-owner");
  expect(transaction.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(releaseUserRoutineAccountBackoffs).mock.invocationCallOrder[0]!,
  );
});

it("keeps routine holds when saving the credential fails", async () => {
  const { save, transaction } = fixture();
  transaction.mockRejectedValueOnce(new Error("credential write failed"));
  await expect(save()).rejects.toThrow("credential write failed");
  expect(releaseUserRoutineAccountBackoffs).not.toHaveBeenCalled();
});
