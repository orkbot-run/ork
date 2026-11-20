// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@orkbot/adapter-kit";
import type { Computer, PrismaClient, ThreadEvents } from "@orkbot/db";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@orkbot/db";
import { createLogger, createTestSink, installLogger } from "@orkbot/logging";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ComputerBusyError, provisionComputer } from "./computer-lifecycle.js";
import { reconcileComputerOrphans } from "./computer-orphan-cleanup.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

class RemoteSandbox extends FakeSandboxProvider {
  override describe() {
    return { ...super.describe(), id: "e2b" };
  }

  override async provision(
    input: Parameters<SandboxProvider["provision"]>[0],
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const ref = { ...(await super.provision(input, context)), kind: "e2b" as const };
    this.boxes.get(ref.id)!.ref = ref;
    await input.recordCreated?.(ref);
    return ref;
  }
}

postgres("durable orphan computer cleanup (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let dataDir: string;
  const address = `orphan-${randomUUID()}@example.test`;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
    identity = await runAsSystem("orphan cleanup integration fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        {
          signupsEnabled: undefined,
          signupAllowlist: undefined,
        },
      ),
    );
    dataDir = await mkdtemp(path.join(tmpdir(), "ork-orphan-cleanup-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    installLogger(createLogger({ service: "orphan-test", level: "off", sinks: [] }));
    await system.computerOrphanCleanup.deleteMany({ where: { spaceId: identity.spaceId } });
  });

  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    await db?.prisma.$disconnect();
    await db?.pool.end();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  function tenant<T>(work: () => T | PromiseLike<T>) {
    return runAsTenant(identity, work);
  }

  async function computer(data: Partial<Computer> = {}) {
    const key = randomUUID();
    return tenant(() =>
      db.prisma.computer.create({
        data: {
          spaceId: identity.spaceId,
          userId: identity.userId,
          scopeKey: `orphan-${key}`,
          homeKey: `orphan-${key}`,
          kind: "e2b",
          ...data,
        },
      }),
    );
  }

  async function job(owner: Computer, data = {}) {
    return system.computerOrphanCleanup.create({
      data: {
        kind: "e2b",
        providerRef: `remote-${randomUUID()}`,
        connection: "",
        computerId: owner.id,
        homeKey: owner.homeKey,
        spaceId: owner.spaceId,
        userId: owner.userId,
        nextAttemptAt: new Date(0),
        ...data,
      },
    });
  }

  function lifecycle(sandbox: SandboxProvider) {
    return {
      prisma: db.prisma,
      sandbox,
      home: new LocalAgentHomeStore(dataDir),
      jobs: { enqueue: vi.fn(), cancel: vi.fn() } as unknown as JobPublisher,
      events: { append: vi.fn() } as unknown as ThreadEvents,
      dataDir,
    };
  }

  function context(): AdapterContext {
    const id = randomUUID();
    return {
      operationId: id,
      traceId: id,
      spaceId: identity.spaceId,
      userId: identity.userId,
      signal: new AbortController().signal,
    };
  }

  it("records the remote id before a boot process dies and removes it after computer deletion", async () => {
    const owner = await computer();
    const sandbox = new RemoteSandbox();
    const provision = sandbox.provision.bind(sandbox);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let recorded!: () => void;
    const created = new Promise<void>((resolve) => {
      recorded = resolve;
    });
    vi.spyOn(sandbox, "provision").mockImplementationOnce(async (...args) => {
      await provision(...args);
      recorded();
      await gate;
      throw new Error("boot process ended");
    });
    const boot = tenant(() => provisionComputer(lifecycle(sandbox), owner.id, context()));
    const stopped = boot.catch(() => undefined);
    await Promise.race([created, boot]);
    const queued = await system.computerOrphanCleanup.findFirstOrThrow({
      where: { computerId: owner.id },
    });
    expect(queued.providerRef).toBe(`fake-${owner.homeKey}`);
    await tenant(() => db.prisma.computer.delete({ where: { id: owner.id } }));
    const destroy = vi.spyOn(sandbox, "destroy");
    await reconcileComputerOrphans({ prisma: db.prisma, sandbox });
    expect(destroy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "e2b", providerRef: queued.providerRef }),
      expect.anything(),
    );
    expect(sandbox.boxes.size).toBe(0);
    expect(await system.computerOrphanCleanup.count({ where: { computerId: owner.id } })).toBe(0);
    release();
    await stopped;
  });

  it("defers a live boot even when unrelated writes leave updatedAt old", async () => {
    const now = new Date();
    const owner = await computer({
      state: "booting",
      updatedAt: new Date(0),
      bootHeartbeatAt: now,
    });
    await job(owner);
    expect(await tenant(() => db.prisma.computerOrphanCleanup.count())).toBe(0);
    const sandbox = new RemoteSandbox();
    const destroy = vi.spyOn(sandbox, "destroy");
    await reconcileComputerOrphans({ prisma: db.prisma, sandbox }, now);
    expect(destroy).not.toHaveBeenCalled();
    expect(
      await system.computerOrphanCleanup.findFirstOrThrow({ where: { computerId: owner.id } }),
    ).toMatchObject({ attempts: 0, nextAttemptAt: new Date(now.getTime() + 30_000) });
  });

  it("fences an abandoned boot before destroying its identified orphan", async () => {
    const owner = await computer({ state: "booting", bootHeartbeatAt: new Date(0) });
    const queued = await job(owner);
    const sandbox = new RemoteSandbox();
    const destroy = vi.spyOn(sandbox, "destroy").mockImplementation(async () => {
      expect(await system.computer.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({
        state: "error",
        bootHeartbeatAt: null,
      });
    });
    await reconcileComputerOrphans({ prisma: db.prisma, sandbox });
    expect(destroy).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: queued.providerRef }),
      expect.anything(),
    );
  });

  it("defers a stale boot while its run still holds a live lease", async () => {
    const owner = await computer({ state: "booting", bootHeartbeatAt: new Date(0) });
    const { botId, threadId, spaceId, userId } = identity;
    const old = await system.bot.findUniqueOrThrow({ where: { id: botId } });
    await system.bot.update({ where: { id: botId }, data: { computerId: owner.id } });
    const task = await system.task.create({
      data: { userId, spaceId, botId, threadId, prompt: "orphan fixture", status: "running" },
    });
    const now = new Date();
    await system.run.create({
      data: {
        userId,
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        trigger: "user",
        status: "running",
        leaseExpiresAt: new Date(now.getTime() + 60_000),
      },
    });
    try {
      await job(owner);
      const sandbox = new RemoteSandbox();
      const destroy = vi.spyOn(sandbox, "destroy");
      await reconcileComputerOrphans({ prisma: db.prisma, sandbox }, now);
      expect(destroy).not.toHaveBeenCalled();
      expect(await system.computerOrphanCleanup.count({ where: { computerId: owner.id } })).toBe(1);
    } finally {
      await system.task.delete({ where: { id: task.id } });
      await system.bot.update({ where: { id: botId }, data: { computerId: old.computerId } });
    }
  });

  it("drains a job without destroying a reference attached to another computer", async () => {
    const owner = await computer();
    const queued = await job(owner);
    await computer({ state: "running", providerRef: queued.providerRef });
    const sandbox = new RemoteSandbox();
    const destroy = vi.spyOn(sandbox, "destroy");
    await reconcileComputerOrphans({ prisma: db.prisma, sandbox });
    expect(destroy).not.toHaveBeenCalled();
    expect(await system.computerOrphanCleanup.count({ where: { computerId: owner.id } })).toBe(0);
  });

  it("retries a failed start whose first provider deletion also failed", async () => {
    const owner = await computer();
    const sandbox = new RemoteSandbox();
    vi.spyOn(sandbox, "prepare").mockRejectedValueOnce(new Error("setup failed"));
    const destroy = vi
      .spyOn(sandbox, "destroy")
      .mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(
      tenant(() => provisionComputer(lifecycle(sandbox), owner.id, context())),
    ).rejects.toThrow("setup failed");
    expect(await system.computerOrphanCleanup.count({ where: { computerId: owner.id } })).toBe(1);
    expect(sandbox.boxes.size).toBe(1);
    await reconcileComputerOrphans({ prisma: db.prisma, sandbox });
    const retry = await system.computerOrphanCleanup.findFirstOrThrow({
      where: { computerId: owner.id },
    });
    expect(retry.attempts).toBe(1);
    expect(sandbox.boxes.size).toBe(1);
    await reconcileComputerOrphans({ prisma: db.prisma, sandbox }, retry.nextAttemptAt);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(sandbox.boxes.size).toBe(0);
    expect(await system.computerOrphanCleanup.count({ where: { computerId: owner.id } })).toBe(0);
  });

  it("activates a successful start and clears its registration in the same transaction", async () => {
    const owner = await computer();
    const sandbox = new RemoteSandbox();
    const ref = await tenant(() => provisionComputer(lifecycle(sandbox), owner.id, context()));
    expect(
      await tenant(() => db.prisma.computer.findUniqueOrThrow({ where: { id: owner.id } })),
    ).toMatchObject({ state: "running", providerRef: ref.providerRef });
    expect(await system.computerOrphanCleanup.count({ where: { computerId: owner.id } })).toBe(0);
    const destroy = vi.spyOn(sandbox, "destroy");
    await reconcileComputerOrphans({ prisma: db.prisma, sandbox });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("backs off exponentially and retains the sixth failure with a diagnostic log", async () => {
    const owner = await computer();
    const queued = await job(owner);
    const sink = createTestSink();
    installLogger(createLogger({ service: "orphan-test", level: "debug", sinks: [sink] }));
    const sandbox = new RemoteSandbox();
    const destroy = vi
      .spyOn(sandbox, "destroy")
      .mockRejectedValue(new Error("provider unavailable"));
    let now = new Date();
    for (let attempts = 1; attempts <= 6; attempts++) {
      await reconcileComputerOrphans({ prisma: db.prisma, sandbox }, now);
      const pending = await system.computerOrphanCleanup.findFirstOrThrow({
        where: { computerId: owner.id },
      });
      expect(pending).toMatchObject({
        attempts,
        leaseId: null,
        leaseExpiresAt: null,
        failedAt: attempts === 6 ? now : null,
        nextAttemptAt: new Date(now.getTime() + 30_000 * 2 ** (attempts - 1)),
      });
      now = pending.nextAttemptAt;
      await reconcileComputerOrphans({ prisma: db.prisma, sandbox }, new Date(now.getTime() - 1));
      expect(destroy).toHaveBeenCalledTimes(attempts);
    }
    await reconcileComputerOrphans(
      { prisma: db.prisma, sandbox },
      new Date(now.getTime() + 86_400_000),
    );
    expect(destroy).toHaveBeenCalledTimes(6);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "computer.orphan_cleanup_exhausted",
        providerRef: queued.providerRef,
        attempts: 6,
      }),
    );
  });

  it("leases an orphan once while a second reconciliation overlaps the provider call", async () => {
    const owner = await computer();
    await job(owner);
    const sandbox = new RemoteSandbox();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const destroy = vi.spyOn(sandbox, "destroy").mockImplementation(async () => {
      entered();
      await gate;
    });
    const first = reconcileComputerOrphans({ prisma: db.prisma, sandbox });
    try {
      await started;
      await reconcileComputerOrphans({ prisma: db.prisma, sandbox });
      expect(destroy).toHaveBeenCalledTimes(1);
      const provision = vi.spyOn(sandbox, "provision");
      await expect(
        tenant(() => provisionComputer(lifecycle(sandbox), owner.id, context())),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      expect(provision).not.toHaveBeenCalled();
    } finally {
      release();
      await first;
    }
    expect(await system.computerOrphanCleanup.count({ where: { computerId: owner.id } })).toBe(0);
  });
});
