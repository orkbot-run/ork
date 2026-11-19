// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it, vi } from "vitest";
import type { SpaceDeletionDeps } from "./space-deletion.js";
import { sweepWorkspaceLifecycleStorage } from "./workspace-lifecycle-sweep.js";

function fixture() {
  const receipt = { spaceIds: ["space-1"], homeKeys: ["home-1"], homeStorageIds: ["a".repeat(32)] };
  const deps = {
    prisma: {
      workspaceLifecycleReceipt: {
        findUnique: vi.fn().mockResolvedValue(receipt),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      space: { count: vi.fn().mockResolvedValue(0) },
      computer: { count: vi.fn().mockResolvedValue(0) },
    },
    artifacts: { purgeSpace: vi.fn().mockResolvedValue(undefined) },
    home: {
      purge: vi.fn().mockResolvedValue(undefined),
      purgeStorageIds: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as SpaceDeletionDeps;
  return { deps, receipt };
}

it("sweeps recorded home and artifact namespaces after the workspace is gone", async () => {
  const { deps } = fixture();
  await sweepWorkspaceLifecycleStorage(deps, "operation", new AbortController().signal);
  expect(deps.artifacts.purgeSpace).toHaveBeenCalledWith(
    expect.objectContaining({ spaceId: "space-1" }),
  );
  expect(deps.home.purge).toHaveBeenCalledWith("home-1");
  expect(deps.home.purgeStorageIds).toHaveBeenCalledWith(["a".repeat(32)]);
  expect(deps.prisma.workspaceLifecycleReceipt.updateMany).toHaveBeenCalled();
});

it("never sweeps a namespace that belongs to a live space or computer", async () => {
  const { deps } = fixture();
  vi.mocked(deps.prisma.space.count).mockResolvedValueOnce(1);
  await expect(
    sweepWorkspaceLifecycleStorage(deps, "operation", new AbortController().signal),
  ).rejects.toThrow("still in use");
  vi.mocked(deps.prisma.computer.count).mockResolvedValueOnce(1);
  await expect(
    sweepWorkspaceLifecycleStorage(deps, "operation", new AbortController().signal),
  ).rejects.toThrow("still in use");
  expect(deps.artifacts.purgeSpace).not.toHaveBeenCalled();
  expect(deps.home.purge).not.toHaveBeenCalled();
});

it("rejects malformed manifests and does not mark a failed cleanup as swept", async () => {
  const { deps, receipt } = fixture();
  receipt.spaceIds = ["../other"];
  await expect(
    sweepWorkspaceLifecycleStorage(deps, "operation", new AbortController().signal),
  ).rejects.toThrow("invalid");
  expect(deps.artifacts.purgeSpace).not.toHaveBeenCalled();
  expect(deps.prisma.workspaceLifecycleReceipt.updateMany).not.toHaveBeenCalled();
});
