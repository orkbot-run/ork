// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AgentHomeStore, SandboxProvider } from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import { expect, it, vi } from "vitest";

const archive = vi.hoisted(() => ({ checkpoint: vi.fn(), revoke: vi.fn(), record: vi.fn() }));
vi.mock("./computer-workspace.js", async (original) => ({
  ...(await original<typeof import("./computer-workspace.js")>()),
  checkpointComputerWorkspace: archive.checkpoint,
}));
vi.mock("./computer-control.js", async (original) => ({
  ...(await original<typeof import("./computer-control.js")>()),
  revokeScreenControl: archive.revoke,
}));
vi.mock("@orkbot/db", async (original) => ({
  ...(await original<typeof import("@orkbot/db")>()),
  recordComputerRunEnd: archive.record,
}));

import { suspendWorkspaceComputers, workspaceLifecycleSpaces } from "./workspace-lifecycle.js";

it("selects only the local spaces of the current disabled workspace admission", async () => {
  const installation = { serverId: "server", organizationId: "org", bindingVersion: 3 };
  const operation = {
    workspaceId: "central-workspace",
    operationId: "operation",
    kind: "archive" as const,
    permissionVersion: 7,
    localOrganizationId: "local-org",
    localWorkspaceId: "root-space",
  };
  const binding = {
    id: operation.workspaceId,
    serverId: installation.serverId,
    centralOrganizationId: installation.organizationId,
    bindingVersion: 3,
    permissionVersion: 7,
    state: "disabled",
    validUntil: new Date(Date.now() + 60_000),
    localOrganizationId: "local-org",
    spaceId: "root-space",
  };
  const findUnique = vi.fn().mockResolvedValue(binding);
  const findMany = vi.fn().mockResolvedValue([{ id: "child-space" }, { id: "root-space" }]);
  const prisma = {
    centralWorkspaceBinding: { findUnique },
    space: { findMany },
  } as unknown as PrismaClient;
  await expect(workspaceLifecycleSpaces(prisma, installation, operation)).resolves.toEqual([
    "child-space",
    "root-space",
  ]);
  expect(findMany).toHaveBeenCalledWith({
    where: {
      organizationId: "local-org",
      OR: [
        { id: "root-space" },
        { admissionWorkspaceId: "central-workspace", centralBinding: null },
      ],
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  for (const change of [
    { serverId: "other-server" },
    { centralOrganizationId: "other-org" },
    { bindingVersion: 4 },
    { permissionVersion: 8 },
    { state: "ready" },
    { validUntil: new Date(0) },
    { localOrganizationId: "other-local-org" },
    { spaceId: "other-root" },
  ]) {
    findUnique.mockResolvedValueOnce({ ...binding, ...change });
    await expect(workspaceLifecycleSpaces(prisma, installation, operation)).rejects.toThrow();
  }
  expect(findMany).toHaveBeenCalledTimes(1);
  findMany.mockResolvedValueOnce([{ id: "child-space" }]);
  await expect(workspaceLifecycleSpaces(prisma, installation, operation)).rejects.toThrow("root");
});

it("checkpoints before stopping and leaves the workspace pending on a failed save", async () => {
  const installation = { serverId: "server", organizationId: "org", bindingVersion: 3 };
  const operation = {
    workspaceId: "central-workspace",
    operationId: "operation",
    kind: "archive" as const,
    permissionVersion: 7,
    localOrganizationId: "local-org",
    localWorkspaceId: "root-space",
  };
  const computer = {
    id: "computer",
    spaceId: "root-space",
    userId: "user",
    homeKey: "home",
    scope: "team",
    state: "running",
    kind: "docker",
    providerRef: "container",
    updatedAt: new Date(),
    maintenanceId: null,
    executionRunId: null,
    controlLeaseId: null,
  };
  const binding = {
    id: operation.workspaceId,
    serverId: installation.serverId,
    centralOrganizationId: "org",
    bindingVersion: 3,
    permissionVersion: 7,
    state: "disabled",
    validUntil: new Date(Date.now() + 60_000),
    localOrganizationId: "local-org",
    spaceId: "root-space",
  };
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    centralWorkspaceBinding: { findUnique: vi.fn().mockResolvedValue(binding) },
    space: { findMany: vi.fn().mockResolvedValue([{ id: "root-space" }]) },
    run: { count: vi.fn().mockResolvedValue(0) },
    computer: {
      findMany: vi.fn().mockResolvedValue([computer]),
      count: vi.fn().mockResolvedValue(0),
      updateMany,
    },
  } as unknown as PrismaClient;
  const stop = vi.fn().mockResolvedValue(undefined);
  const sandbox = {
    keepsHome: vi.fn().mockResolvedValue(true),
    stop,
  } as unknown as SandboxProvider;
  const deps = { prisma, sandbox, home: {} as AgentHomeStore };
  archive.revoke.mockResolvedValue(undefined);
  archive.record.mockResolvedValue(undefined);
  archive.checkpoint.mockRejectedValueOnce(new Error("save unavailable"));
  await expect(
    suspendWorkspaceComputers(deps, installation, operation, new AbortController().signal),
  ).rejects.toThrow("save unavailable");
  expect(stop).not.toHaveBeenCalled();
  expect(updateMany).toHaveBeenLastCalledWith(
    expect.objectContaining({ data: { state: "running" } }),
  );
  archive.checkpoint.mockResolvedValueOnce("revision-1");
  await expect(
    suspendWorkspaceComputers(deps, installation, operation, new AbortController().signal),
  ).resolves.toBe(true);
  expect(stop).toHaveBeenCalledOnce();
  expect(archive.checkpoint.mock.invocationCallOrder.at(-1)).toBeLessThan(
    stop.mock.invocationCallOrder[0]!,
  );
  expect(updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ state: "suspended" }),
    }),
  );
});

it("waits for running work and does not stop a computer with an unsafe snapshot", async () => {
  const installation = { serverId: "server", organizationId: "org", bindingVersion: 3 };
  const operation = {
    workspaceId: "workspace",
    operationId: "operation",
    kind: "archive" as const,
    permissionVersion: 1,
    localOrganizationId: "local-org",
    localWorkspaceId: "space",
  };
  const prisma = {
    centralWorkspaceBinding: {
      findUnique: vi.fn().mockResolvedValue({
        id: "workspace",
        serverId: "server",
        centralOrganizationId: "org",
        bindingVersion: 3,
        permissionVersion: 1,
        state: "disabled",
        validUntil: new Date(Date.now() + 60_000),
        localOrganizationId: "local-org",
        spaceId: "space",
      }),
    },
    space: { findMany: vi.fn().mockResolvedValue([{ id: "space" }]) },
    run: {
      count: vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    computer: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "computer",
          spaceId: "space",
          userId: "user",
          homeKey: "home",
          scope: "team",
          state: "running",
          kind: "docker",
          providerRef: "container",
          updatedAt: new Date(),
          maintenanceId: null,
          executionRunId: null,
        },
      ]),
      updateMany: vi.fn(),
    },
  } as unknown as PrismaClient;
  const stop = vi.fn();
  const sandbox = {
    keepsHome: vi.fn().mockResolvedValue(false),
    stop,
  } as unknown as SandboxProvider;
  const deps = { prisma, sandbox, home: {} as AgentHomeStore };
  await expect(
    suspendWorkspaceComputers(deps, installation, operation, new AbortController().signal),
  ).resolves.toBe(false);
  await expect(
    suspendWorkspaceComputers(deps, installation, operation, new AbortController().signal),
  ).rejects.toThrow("cannot preserve its complete disk");
  expect(stop).not.toHaveBeenCalled();
  expect(prisma.computer.updateMany).not.toHaveBeenCalled();
});

it("does not treat an unavailable provider as a stopped computer during recovery", async () => {
  const installation = { serverId: "server", organizationId: "org", bindingVersion: 3 };
  const operation = {
    workspaceId: "workspace",
    operationId: "operation",
    kind: "archive" as const,
    permissionVersion: 1,
    localOrganizationId: "local-org",
    localWorkspaceId: "space",
  };
  const prisma = {
    centralWorkspaceBinding: {
      findUnique: vi.fn().mockResolvedValue({
        id: "workspace",
        serverId: "server",
        centralOrganizationId: "org",
        bindingVersion: 3,
        permissionVersion: 1,
        state: "disabled",
        validUntil: new Date(Date.now() + 60_000),
        localOrganizationId: "local-org",
        spaceId: "space",
      }),
    },
    space: { findMany: vi.fn().mockResolvedValue([{ id: "space" }]) },
    run: { count: vi.fn().mockResolvedValue(0) },
    computer: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "computer",
          spaceId: "space",
          userId: "user",
          homeKey: "home",
          scope: "team",
          state: "suspending",
          kind: "docker",
          providerRef: "container",
          updatedAt: new Date(Date.now() - 2 * 60 * 60_000),
          maintenanceId: null,
          executionRunId: null,
        },
      ]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  } as unknown as PrismaClient;
  const sandbox = {
    keepsHome: vi.fn().mockResolvedValue(true),
    isRunning: vi.fn().mockResolvedValue(false),
    stop: vi.fn().mockRejectedValue(new Error("provider unavailable")),
  } as unknown as SandboxProvider;
  archive.revoke.mockResolvedValue(undefined);
  await expect(
    suspendWorkspaceComputers(
      { prisma, sandbox, home: {} as AgentHomeStore },
      installation,
      operation,
      new AbortController().signal,
    ),
  ).rejects.toThrow("provider unavailable");
  expect(sandbox.isRunning).not.toHaveBeenCalled();
  expect(sandbox.stop).toHaveBeenCalledOnce();
});
