// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited material remains Apache-2.0; Ork cancellation changes are PolyForm-covered.
// Modified by Ork contributors to match domain module imports.

import { LocalAgentHomeStore } from "@orkbot/adapters";
import type * as Db from "@orkbot/db";
import {
  claimOrganizationForDeletion,
  deleteClaimedSpace,
  recordAuditEvent,
  recordComputerRunEnd,
  setOrganizationDeletionLease,
} from "@orkbot/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteOrganization } from "./account-deletion.js";

vi.mock("@orkbot/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  claimOrganizationForDeletion: vi.fn(),
  keepOrganizationTrialUse: vi.fn(async () => undefined),
  setOrganizationDeletionLease: vi.fn(),
  deleteClaimedSpace: vi.fn(),
  deleteEmptyOrganization: vi.fn(async () => undefined),
  releaseOrganizationDeletionClaim: vi.fn(async () => undefined),
  recordAuditEvent: vi.fn(async () => undefined),
  recordComputerRunEnd: vi.fn(async () => undefined),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("deleteOrganization lease", () => {
  let spacesLeft: number;
  const prisma = {
    organization: { findUnique: vi.fn(async () => ({ name: "Work" })) },
    artifact: { findMany: vi.fn(async () => []) },
    bot: { findMany: vi.fn(async () => []) },
    computer: { findMany: vi.fn(async () => []) },
    space: { count: vi.fn(async () => spacesLeft) },
  };
  const deps = (overrides: Record<string, unknown> = {}) =>
    ({
      prisma,
      artifacts: { remove: vi.fn(async () => undefined) },
      ...overrides,
    }) as unknown as Parameters<typeof deleteOrganization>[0];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    spacesLeft = 1;
    vi.mocked(claimOrganizationForDeletion).mockResolvedValue({
      claimId: "organization-deletion:org-1:attempt",
      spaceIds: ["space-1"],
      fresh: true,
    });
    vi.mocked(setOrganizationDeletionLease).mockImplementation(async () => spacesLeft > 0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finishes and records a deletion whose last file cleanup outlasts the lease", async () => {
    const cleanup = deferred();
    vi.mocked(deleteClaimedSpace).mockImplementation(async () => {
      spacesLeft = 0;
      return { artifactKeys: ["blob-1"], pageShareSecrets: [] };
    });
    const remove = vi.fn(() => cleanup.promise);

    const deleting = deleteOrganization(deps({ artifacts: { remove } }), "user-1", "org-1");
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    cleanup.resolve();

    await expect(deleting).resolves.toBeUndefined();
    expect(recordAuditEvent).toHaveBeenCalledOnce();
  });

  it("stops before teardown once renewals fail for most of the lease", async () => {
    const billing = deferred();
    let billingCalled = false;
    vi.mocked(setOrganizationDeletionLease).mockRejectedValue(new Error("database unavailable"));

    const deleting = deleteOrganization(
      deps({
        billing: {
          cancelForDeletedOrganization: () => {
            billingCalled = true;
            return billing.promise;
          },
        },
      }),
      "user-1",
      "org-1",
    );
    deleting.catch(() => undefined);
    await vi.waitFor(() => expect(billingCalled).toBe(true));
    await vi.advanceTimersByTimeAsync(4 * 60_000);

    await expect(deleting).rejects.toThrow("lost its claim");
    billing.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(prisma.artifact.findMany).not.toHaveBeenCalled();
    expect(prisma.bot.findMany).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  it("starts no computer cleanup when destruction returns after cancellation", async () => {
    const destruction = deferred();
    const destroy = vi.fn(() => destruction.promise);
    const home = new LocalAgentHomeStore("/tmp/ork-deletion-test");
    const removeHome = vi.spyOn(home, "remove").mockResolvedValue(undefined);
    const deleteComputer = vi.fn().mockResolvedValue({ count: 1 });
    const stopping = new AbortController();
    const cancelled = new Error("Organization deletion lost its claim");
    const deleting = deleteOrganization(
      deps({
        prisma: {
          ...prisma,
          computer: {
            findMany: vi.fn().mockResolvedValue([
              {
                id: "computer-1",
                spaceId: "space-1",
                homeKey: "home-1",
                kind: "docker",
                providerRef: "container-1",
                bots: [],
              },
            ]),
            deleteMany: deleteComputer,
          },
        },
        sandbox: { destroy },
        home,
      }),
      "user-1",
      "org-1",
      stopping.signal,
    );
    deleting.catch(() => undefined);
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());

    stopping.abort(cancelled);
    await expect(deleting).rejects.toBe(cancelled);
    destruction.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(recordComputerRunEnd).not.toHaveBeenCalled();
    expect(removeHome).not.toHaveBeenCalled();
    expect(deleteComputer).not.toHaveBeenCalled();
    expect(deleteClaimedSpace).not.toHaveBeenCalled();
    removeHome.mockRestore();
  });
});
