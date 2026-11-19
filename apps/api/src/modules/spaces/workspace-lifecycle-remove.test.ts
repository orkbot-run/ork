// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { InstallationConfiguration } from "@orkbot/auth/installation-client";
import type { WorkspaceLifecycleOperation } from "@orkbot/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import type { SpaceDeletionDeps } from "./space-deletion.js";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  renew: vi.fn(),
  complete: vi.fn(),
  remove: vi.fn(),
  sweep: vi.fn(),
}));
vi.mock("./workspace-lifecycle-receipt.js", () => ({
  claimWorkspaceLifecycleReceipt: mocks.claim,
  renewWorkspaceLifecycleReceipt: mocks.renew,
  completeWorkspaceLifecycleReceipt: mocks.complete,
}));
vi.mock("./space-deletion.js", () => ({ deleteSpaceWithContent: mocks.remove }));
vi.mock("./workspace-lifecycle-sweep.js", () => ({ sweepWorkspaceLifecycleStorage: mocks.sweep }));

import { removeManagedWorkspace } from "./workspace-lifecycle-remove.js";

const deps = { prisma: {} } as SpaceDeletionDeps;
const configuration = {
  serverId: "server",
  organizationId: "org",
  bindingVersion: 1,
  keyFingerprint: "key",
} as InstallationConfiguration;
const operation = {
  operationId: "operation",
  workspaceId: "workspace",
  permissionVersion: 2,
  kind: "delete",
  localOrganizationId: "local-org",
  localWorkspaceId: "root",
} as WorkspaceLifecycleOperation;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.claim.mockResolvedValue({
    complete: false,
    claimId: "claim",
    spaceIds: ["root", "child-a", "child-b"],
  });
  mocks.renew.mockResolvedValue(true);
  mocks.complete.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.sweep.mockResolvedValue(undefined);
});

it("removes every child before the root, then commits the durable receipt", async () => {
  await expect(
    removeManagedWorkspace(deps, configuration, operation, new AbortController().signal),
  ).resolves.toBe(true);
  expect(mocks.remove.mock.calls.map((call) => call[2])).toEqual(["child-a", "child-b", "root"]);
  expect(mocks.complete).toHaveBeenCalledWith(deps.prisma, "operation", "claim");
  expect(mocks.remove.mock.invocationCallOrder.at(-1)).toBeLessThan(
    mocks.complete.mock.invocationCallOrder[0]!,
  );
});

it("never completes the receipt after a failed teardown or an expired claim", async () => {
  mocks.remove.mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(
    removeManagedWorkspace(deps, configuration, operation, new AbortController().signal),
  ).rejects.toThrow("storage unavailable");
  expect(mocks.complete).not.toHaveBeenCalled();
  mocks.renew.mockResolvedValueOnce(false);
  await expect(
    removeManagedWorkspace(deps, configuration, operation, new AbortController().signal),
  ).rejects.toThrow("lease expired");
  expect(mocks.complete).not.toHaveBeenCalled();
});

it("can acknowledge an already completed receipt after a lost response", async () => {
  mocks.claim.mockResolvedValueOnce({ complete: true, spaceIds: ["root"] });
  await expect(
    removeManagedWorkspace(deps, configuration, operation, new AbortController().signal),
  ).resolves.toBe(true);
  expect(mocks.remove).not.toHaveBeenCalled();
});
