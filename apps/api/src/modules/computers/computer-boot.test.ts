// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited boot tests remain Apache-2.0; Space admission fixture support is an Ork addition.

import type { SandboxProvider } from "@orkbot/adapter-kit";
import { SandboxDamagedError } from "@orkbot/adapter-kit";
import type * as Adapters from "@orkbot/adapters";
import { ComputerBusyError, FakeSandboxProvider, NoneSandboxProvider } from "@orkbot/adapters";
import type { Actor } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { Prisma } from "@orkbot/db";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";
import { handleRpcError } from "../../app.js";

const lifecycle = vi.hoisted(() => ({
  realAcquire: undefined as typeof Adapters.acquireComputerExecutionLease | undefined,
  acquireComputerExecutionLease: vi.fn(),
  provisionComputer: vi.fn(),
  releaseComputerExecutionLease: vi.fn(),
}));

vi.mock("@orkbot/adapters", async (original) => {
  const adapters = await original<typeof Adapters>();
  lifecycle.realAcquire = adapters.acquireComputerExecutionLease;
  return {
    ...adapters,
    acquireComputerExecutionLease: lifecycle.acquireComputerExecutionLease,
    provisionComputer: lifecycle.provisionComputer,
    releaseComputerExecutionLease: lifecycle.releaseComputerExecutionLease,
  };
});

const actor = {
  spaceId: "workspace-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: true,
} satisfies Actor;

function routerDeps(prisma: PrismaClient) {
  return {
    prisma,
    sandbox: new FakeSandboxProvider(),
    jobs: { enqueue: vi.fn() },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "https://web.example.test",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/orkbot-router-test",
  } as unknown as RouterDeps;
}

async function boot(
  prisma: PrismaClient,
  options: {
    action?: "boot" | "takeover" | "screenUrl" | "terminalUrl";
    sandbox?: SandboxProvider;
  } = {},
) {
  const deps = routerDeps(prisma);
  if (options.sandbox) deps.sandbox = options.sandbox;
  const handler = new RPCHandler(createRouter(deps), {
    clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
  });
  const { response } = await handler.handle(
    new Request(`https://api.example.test/rpc/computer/${options.action ?? "boot"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { botId: "bot-1" } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  return response;
}

const stoppedBot = {
  id: "bot-1",
  userId: actor.userId,
  spaceId: actor.spaceId,
  thread: { id: "thread-1" },
  computer: { id: "computer-1", state: "stopped", providerRef: null, scope: "team" },
};

beforeEach(() => {
  lifecycle.acquireComputerExecutionLease.mockReset().mockResolvedValue(null);
  lifecycle.provisionComputer.mockReset();
  lifecycle.releaseComputerExecutionLease.mockReset();
});

describe("computer boot", () => {
  it("refuses a disabled start before claiming a lease or provisioning", async () => {
    const prisma = { bot: { findFirst: vi.fn(async () => stoppedBot) } } as unknown as PrismaClient;
    const response = await boot(prisma, { sandbox: new NoneSandboxProvider() });
    expect(response?.status).toBe(400);
    expect(lifecycle.acquireComputerExecutionLease).not.toHaveBeenCalled();
    expect(lifecycle.provisionComputer).not.toHaveBeenCalled();
  });

  it("refuses graphical control before any lease write on a headless active target", async () => {
    const sandbox = new FakeSandboxProvider();
    const descriptor = sandbox.describe();
    vi.spyOn(sandbox, "describe").mockReturnValue({
      ...descriptor,
      capabilities: { ...descriptor.capabilities, graphical: false, takeover: false },
    });
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          ...stoppedBot,
          computer: {
            ...stoppedBot.computer,
            state: "running",
            kind: "fake",
            providerRef: "active",
          },
        })),
      },
      computer: { updateMany: vi.fn() },
    } as unknown as PrismaClient;
    const response = await boot(prisma, { action: "takeover", sandbox });
    expect(response?.status).toBe(400);
    expect(prisma.computer.updateMany).not.toHaveBeenCalled();
    expect(lifecycle.acquireComputerExecutionLease).not.toHaveBeenCalled();
  });
  it("fences the checked active reference when acquiring graphical control", async () => {
    const computer = {
      ...stoppedBot.computer,
      state: "running",
      kind: "fake",
      providerRef: "checked-reference",
      controlHolder: "none",
      controlLeaseId: null,
    };
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      bot: { findFirst: vi.fn(async () => ({ ...stoppedBot, computer })) },
      computerExecutionLease: { findUnique: vi.fn(async () => null) },
      computer: {
        updateMany,
        findUniqueOrThrow: vi.fn(async () => ({
          ...computer,
          kind: "desktop",
          providerRef: "replacement",
        })),
      },
    } as unknown as PrismaClient;
    const response = await boot(prisma, { action: "takeover" });
    expect(response?.status).toBe(409);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "fake",
          providerRef: "checked-reference",
          controlLeaseId: null,
        }),
      }),
    );
  });

  it.each([false, true])("uses claimless lease acquisition when busy=%s", async (busy) => {
    lifecycle.acquireComputerExecutionLease.mockImplementation(lifecycle.realAcquire!);
    lifecycle.provisionComputer.mockRejectedValue(new Error("stop after the lease"));
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      computer: { findUniqueOrThrow: vi.fn().mockResolvedValue(stoppedBot.computer) },
      computerExecutionLease: {
        updateManyAndReturn: vi.fn().mockResolvedValue([]),
        create: busy
          ? vi.fn().mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }))
          : vi.fn().mockResolvedValue({ fence: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          runId: "run-1",
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
    };
    const prisma = {
      ...tx,
      bot: { findFirst: vi.fn().mockResolvedValue(stoppedBot) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    const response = await boot(prisma);

    expect(tx.computerExecutionLease.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          computerId: "computer-1",
          botId: "bot-1",
          OR: [{ expiresAt: { lt: expect.any(Date) } }],
        },
      }),
    );
    if (busy) {
      expect(response?.status).toBe(409);
      expect(lifecycle.provisionComputer).not.toHaveBeenCalled();
    } else {
      expect(lifecycle.provisionComputer).toHaveBeenCalledOnce();
      expect(lifecycle.releaseComputerExecutionLease).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ runId: expect.stringMatching(/^boot:/), fence: 1 }),
      );
    }
  });

  it("waits for a finished run to let go of the computer", async () => {
    lifecycle.acquireComputerExecutionLease
      .mockRejectedValueOnce(new ComputerBusyError())
      .mockResolvedValueOnce(null);
    lifecycle.provisionComputer.mockRejectedValue(new Error("stop after the lease"));
    const prisma = {
      bot: { findFirst: vi.fn().mockResolvedValue(stoppedBot) },
      computerExecutionLease: {
        findUnique: vi.fn().mockResolvedValue({
          runId: "run-1",
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "completed" }) },
    } as unknown as PrismaClient;

    await boot(prisma);

    expect(prisma.computerExecutionLease.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { computerId_botId: { computerId: "computer-1", botId: "bot-1" } },
      }),
    );
    expect(lifecycle.acquireComputerExecutionLease).toHaveBeenCalledTimes(2);
    expect(lifecycle.provisionComputer).toHaveBeenCalledOnce();
  });

  it("still refuses a boot while the run is going", async () => {
    lifecycle.acquireComputerExecutionLease.mockRejectedValue(new ComputerBusyError());
    const prisma = {
      bot: { findFirst: vi.fn().mockResolvedValue(stoppedBot) },
      computerExecutionLease: {
        findUnique: vi.fn().mockResolvedValue({
          runId: "run-1",
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
    } as unknown as PrismaClient;

    const response = await boot(prisma);

    expect(response?.status).toBe(409);
    expect(lifecycle.acquireComputerExecutionLease).toHaveBeenCalledOnce();
    expect(lifecycle.provisionComputer).not.toHaveBeenCalled();
  });

  it("reports a computer removed while the boot waited as not found", async () => {
    lifecycle.provisionComputer.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("No record was found for a query.", {
        code: "P2025",
        clientVersion: "test",
      }),
    );
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          ...stoppedBot,
          computer: { ...stoppedBot.computer, state: "booting" },
        }),
      },
    } as unknown as PrismaClient;

    const response = await boot(prisma);

    expect(response?.status).toBe(404);
    expect(lifecycle.provisionComputer).toHaveBeenCalledOnce();
    expect(lifecycle.releaseComputerExecutionLease).toHaveBeenCalledOnce();
  });

  it("tells the user to recover a computer that stays damaged after its automatic recovery", async () => {
    lifecycle.provisionComputer.mockRejectedValue(new SandboxDamagedError());
    const prisma = {
      bot: { findFirst: vi.fn().mockResolvedValue(stoppedBot) },
    } as unknown as PrismaClient;

    const response = await boot(prisma);

    expect(response?.status).toBe(409);
    expect(await response?.text()).toContain("Recover the computer to rebuild it.");
    expect(lifecycle.releaseComputerExecutionLease).toHaveBeenCalledOnce();
  });
});

describe("computer stop", () => {
  async function stopDamaged(stop: ReturnType<typeof vi.fn>) {
    const computer = {
      id: "computer-1",
      state: "running",
      providerRef: "boat-1",
      kind: "boat",
      homeKey: "home-1",
      scope: "dedicated",
      controlLeaseId: null,
    };
    const prisma = {
      bot: { findFirst: vi.fn().mockResolvedValue({ ...stoppedBot, computer }) },
      computer: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue(computer),
        findFirst: vi
          .fn()
          .mockResolvedValue({ state: "running", restorePending: false, screenGeneration: 0 }),
      },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
      computerExecutionLease: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      computerRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    } as unknown as PrismaClient;
    const sandbox = {
      // biome-ignore lint/correctness/useYield: the damaged computer fails before its first file
      exportWorkspace: async function* () {
        throw new SandboxDamagedError();
      },
      stop,
    };
    const deps = {
      ...routerDeps(prisma),
      sandbox,
      home: {},
      jobs: { enqueue: vi.fn(), cancel: vi.fn() },
    } as unknown as RouterDeps;
    const { response } = await new RPCHandler(createRouter(deps)).handle(
      new Request("https://api.example.test/rpc/computer/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { response, prisma };
  }

  it("stops a damaged computer and records it stopped", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const { response, prisma } = await stopDamaged(stop);

    expect(response?.status).toBe(200);
    expect(stop).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      discardUnsaved: true,
    });
    expect(prisma.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", state: "suspending", providerRef: "boat-1", kind: "boat" },
      data: expect.objectContaining({ state: "stopped" }),
    });
    expect(prisma.computerRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ endReason: "stopped" }) }),
    );
    expect(prisma.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { computerId: "computer-1", botId: "bot-1" },
      data: { expiresAt: new Date(0) },
    });
    expect(prisma.computerExecutionLease.deleteMany).not.toHaveBeenCalled();
  });

  it("marks a damaged computer whose stop fails as errored", async () => {
    const stop = vi.fn().mockRejectedValue(new Error("Boat refused the stop"));
    const { response, prisma } = await stopDamaged(stop);

    expect(response?.status).toBe(500);
    expect(stop).toHaveBeenCalledOnce();
    expect(prisma.computer.updateMany).toHaveBeenLastCalledWith({
      where: { id: "computer-1", state: "suspending" },
      data: { state: "error" },
    });
    expect(prisma.computer.update).not.toHaveBeenCalled();
  });
});
