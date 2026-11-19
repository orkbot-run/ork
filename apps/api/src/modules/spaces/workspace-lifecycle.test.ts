// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type {
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  SandboxProvider,
} from "@orkbot/adapter-kit";
import type { InstallationClient } from "@orkbot/auth";
import type { PrismaClient } from "@orkbot/db";
import { expect, it, vi } from "vitest";

const suspend = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
vi.mock("@orkbot/adapters", async (original) => ({
  ...(await original<typeof import("@orkbot/adapters")>()),
  suspendWorkspaceComputers: suspend,
}));
vi.mock("./workspace-lifecycle-remove.js", () => ({ removeManagedWorkspace: remove }));
vi.mock("./workspace-lifecycle-sweep.js", () => ({
  sweepCompletedWorkspaceLifecycles: vi.fn().mockResolvedValue(undefined),
}));

import { startWorkspaceLifecycle } from "./workspace-lifecycle.js";
import { WorkspaceExternalMemoryError } from "./workspace-lifecycle-receipt.js";

it("acknowledges an archive only after the server has stopped its computers", async () => {
  const configuration = {
    serverId: "server",
    organizationId: "org",
    bindingVersion: 1,
    keyFingerprint: "key",
  };
  const operation = {
    operationId: "archive",
    workspaceId: "workspace",
    permissionVersion: 1,
    kind: "archive",
    localOrganizationId: "local-org",
    localWorkspaceId: "space",
  };
  const acknowledge = vi.fn().mockResolvedValue(undefined);
  const installation = {
    configuration: vi.fn().mockResolvedValue(configuration),
    pendingWorkspaceLifecycle: vi.fn().mockResolvedValue([operation]),
    acknowledgeWorkspaceLifecycle: acknowledge,
  } as unknown as InstallationClient;
  let finish!: (result: boolean) => void;
  suspend.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  const stop = startWorkspaceLifecycle(
    {
      installation,
      prisma: {} as PrismaClient,
      sandbox: {} as SandboxProvider,
      home: {} as AgentHomeStore,
      artifacts: {} as ArtifactStore,
      jobs: {} as JobPublisher,
      dataDir: "/tmp",
    },
    vi.fn(),
  );
  await vi.waitFor(() => expect(suspend).toHaveBeenCalled());
  expect(acknowledge).not.toHaveBeenCalled();
  finish(true);
  await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledWith("archive", configuration));
  await stop();
});

it("reports a supported failure code without acknowledging incomplete deletion", async () => {
  const configuration = {
    serverId: "server",
    organizationId: "org",
    bindingVersion: 1,
    keyFingerprint: "key",
  };
  const report = vi.fn().mockResolvedValue(undefined);
  const acknowledge = vi.fn();
  const installation = {
    configuration: vi.fn().mockResolvedValue(configuration),
    pendingWorkspaceLifecycle: vi
      .fn()
      .mockResolvedValue([{ operationId: "deletion", kind: "delete" }]),
    acknowledgeWorkspaceLifecycle: acknowledge,
    reportWorkspaceLifecycleError: report,
  } as unknown as InstallationClient;
  remove.mockReset().mockRejectedValueOnce(new WorkspaceExternalMemoryError());
  const stop = startWorkspaceLifecycle(
    {
      installation,
      prisma: {} as PrismaClient,
      sandbox: {} as SandboxProvider,
      home: {} as AgentHomeStore,
      artifacts: {} as ArtifactStore,
      jobs: {} as JobPublisher,
      dataDir: "/tmp",
    },
    vi.fn(),
  );
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith("deletion", "external_memory", configuration),
  );
  await stop();
  expect(acknowledge).not.toHaveBeenCalled();
});

it("does not acknowledge an incomplete archive or a pending deletion", async () => {
  const configuration = {
    serverId: "server",
    organizationId: "org",
    bindingVersion: 1,
    keyFingerprint: "key",
  };
  const acknowledge = vi.fn();
  const installation = {
    configuration: vi.fn().mockResolvedValue(configuration),
    pendingWorkspaceLifecycle: vi.fn().mockResolvedValue([
      { operationId: "archive", kind: "archive" },
      { operationId: "deletion", kind: "delete" },
    ]),
    acknowledgeWorkspaceLifecycle: acknowledge,
  } as unknown as InstallationClient;
  suspend.mockReset().mockResolvedValue(false);
  remove.mockReset().mockResolvedValue(false);
  const stop = startWorkspaceLifecycle(
    {
      installation,
      prisma: {} as PrismaClient,
      sandbox: {} as SandboxProvider,
      home: {} as AgentHomeStore,
      artifacts: {} as ArtifactStore,
      jobs: {} as JobPublisher,
      dataDir: "/tmp",
    },
    vi.fn(),
  );
  await vi.waitFor(() => expect(suspend).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
  await stop();
  expect(acknowledge).not.toHaveBeenCalled();
});
