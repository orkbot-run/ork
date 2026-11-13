// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@orkbot/db";
import {
  appendEvent,
  asSystem,
  createDb,
  createThreadEvents,
  declareRunReaderVersion,
  finalizeRun,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
  runCodeKind,
  runCodeSpentKind,
  runLoginKind,
  runSecretKind,
  saveRunTurnCheckpoint,
} from "@orkbot/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryRealtimeFanout } from "./realtime.js";
import { retireWorkspaceRun } from "./workspace-run-retirement.js";

const url = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const describePostgres = url ? describe.sequential : describe.skip;
type Admission = Parameters<typeof retireWorkspaceRun>[1];

describePostgres("fenced retirement after workspace access ends (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const organizations: string[] = [];
  const users: string[] = [];
  const lease = { owner: "retirement-worker", fence: 7 };

  beforeAll(() => {
    db = createDb(url!, { encryptContent: false });
    system = asSystem(db.prisma);
  });
  afterEach(async () => {
    await system.centralWorkspaceBinding.deleteMany({
      where: { localOrganizationId: { in: organizations } },
    });
    await system.organization.deleteMany({ where: { id: { in: organizations.splice(0) } } });
    await system.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function fixture(managed = true) {
    const identity = await provisionMessagingIdentity(
      system,
      { provider: "email", address: `retirement-${randomUUID()}@example.test` },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    const { spaceId, userId, botId, threadId } = identity;
    const space = await system.space.findUniqueOrThrow({ where: { id: spaceId } });
    organizations.push(space.organizationId);
    users.push(userId);
    const workspaceId = randomUUID();
    if (managed) {
      await system.centralWorkspaceBinding.create({
        data: {
          id: workspaceId,
          serverId: randomUUID(),
          centralOrganizationId: randomUUID(),
          localOrganizationId: space.organizationId,
          spaceId,
          operationId: randomUUID(),
          bindingVersion: 1,
          permissionVersion: 1,
          state: "ready",
          members: [],
          verifiedAt: new Date(),
          validUntil: new Date(Date.now() + 300_000),
        },
      });
      await system.centralWorkspaceAccess.create({
        data: {
          workspaceId,
          userId,
          centralSubject: randomUUID(),
          role: "member",
          membershipVersion: randomUUID(),
          active: true,
        },
      });
    }
    const task = await system.task.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId,
        prompt: "Fictional retained task",
        status: "running",
      },
    });
    const run = await system.run.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: lease.owner,
        leaseFence: lease.fence,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const attempt = await system.attempt.create({
      data: { runId: run.id, fence: lease.fence, status: "running" },
    });
    const fanout = new InMemoryRealtimeFanout();
    const publish = vi.spyOn(fanout, "publish");
    const events = createThreadEvents(db.prisma, fanout);
    const revoke = () =>
      system.centralWorkspaceAccess.updateMany({
        where: { workspaceId, userId },
        data: { active: false },
      });
    const tenant = <T>(fn: () => Promise<T>) => runAsTenant({ spaceId, userId }, fn);
    return { ...identity, workspaceId, task, run, attempt, events, publish, revoke, tenant };
  }

  it("retires an RLS-hidden orphan without restoring data access or admitting a continuation", async () => {
    const f = await fixture();
    await expect(
      f.tenant(() => db.prisma.run.findUnique({ where: { id: f.run.id } })),
    ).resolves.toMatchObject({ id: f.run.id, status: "running" });
    const kinds = [
      runSecretKind(f.run.id),
      runCodeKind(f.run.id),
      runCodeSpentKind(f.run.id),
      runLoginKind(f.run.id, "fixture"),
    ];
    await system.secret.createMany({
      data: kinds.map((kind) => ({
        userId: f.userId,
        spaceId: f.spaceId,
        kind,
        ciphertext: randomUUID(),
      })),
    });
    const retained = await system.secret.create({
      data: {
        userId: f.userId,
        spaceId: f.spaceId,
        kind: "fixture-unrelated",
        ciphertext: randomUUID(),
      },
    });
    await runAsSystem("seed a retained turn checkpoint", () =>
      saveRunTurnCheckpoint(db.prisma, f.run, lease.owner, lease.fence, "fictional checkpoint"),
    );
    const computer = await system.computer.create({
      data: {
        spaceId: f.spaceId,
        userId: f.userId,
        scopeKey: randomUUID(),
        homeKey: randomUUID(),
        kind: "sandbox",
        controlRunId: f.run.id,
        controlHolder: "agent",
        executionRunId: f.run.id,
        executionBotId: f.botId,
        executionLeaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const computerLease = await system.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: f.botId,
        runId: f.run.id,
        fence: lease.fence,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await appendEvent(system, {
      spaceId: f.spaceId,
      threadId: f.threadId,
      botId: f.botId,
      runId: f.run.id,
      type: "thread.progress",
      payload: { text: "Fictional transient progress" },
    });
    await f.revoke();
    await expect(
      f.tenant(() => db.prisma.run.findUnique({ where: { id: f.run.id } })),
    ).resolves.toBeNull();
    await expect(
      f.tenant(() =>
        finalizeRun(db.prisma, {
          spaceId: f.spaceId,
          threadId: f.threadId,
          botId: f.botId,
          taskId: f.task.id,
          runId: f.run.id,
          attemptId: f.attempt.id,
          leaseOwner: lease.owner,
          leaseFence: lease.fence,
          outcome: "failed",
          error: "Workspace access ended",
          partialReply: [],
        }),
      ),
    ).resolves.toBe(false);
    expect(await system.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "running",
    });

    await expect(
      f.tenant(() => retireWorkspaceRun({ prisma: db.prisma, events: f.events }, f.run, lease)),
    ).resolves.toBe(true);
    expect(await system.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "cancelled",
      completedAt: expect.any(Date),
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseFence: lease.fence,
      centralWorkspaceId: f.workspaceId,
    });
    expect(await system.attempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).toMatchObject({
      status: "cancelled",
      finishedAt: expect.any(Date),
    });
    expect(await system.task.findUniqueOrThrow({ where: { id: f.task.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await system.secret.count({ where: { spaceId: f.spaceId, kind: { in: kinds } } })).toBe(
      0,
    );
    expect(await system.secret.findUnique({ where: { id: retained.id } })).not.toBeNull();
    expect(
      await system.externalEffect.count({ where: { runId: f.run.id, kind: "runtime_checkpoint" } }),
    ).toBe(0);
    expect(
      await system.computerExecutionLease.findUniqueOrThrow({ where: { id: computerLease.id } }),
    ).toMatchObject({ expiresAt: new Date(0) });
    expect(await system.computer.findUniqueOrThrow({ where: { id: computer.id } })).toMatchObject({
      controlRunId: null,
      executionRunId: null,
      executionBotId: null,
      executionLeaseExpiresAt: null,
    });
    const committed = await system.event.findMany({ where: { runId: f.run.id } });
    expect(committed).toEqual([expect.objectContaining({ type: "run.cancelled" })]);
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(
      `thread:${f.threadId}`,
      JSON.stringify({ cursor: committed[0]!.seq }),
    );
    await expect(
      f.tenant(() => db.prisma.run.findUnique({ where: { id: f.run.id } })),
    ).resolves.toBeNull();
    await expect(
      f.tenant(() =>
        db.prisma.run.create({
          data: {
            spaceId: f.spaceId,
            userId: f.userId,
            botId: f.botId,
            threadId: f.threadId,
            taskId: f.task.id,
            status: "queued",
            trigger: "follow_up",
          },
        }),
      ),
    ).rejects.toThrow();
    expect(await system.run.count({ where: { taskId: f.task.id } })).toBe(1);
    await expect(
      f.tenant(() => retireWorkspaceRun({ prisma: db.prisma, events: f.events }, f.run, lease)),
    ).resolves.toBe(false);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(await system.event.count({ where: { runId: f.run.id, type: "run.cancelled" } })).toBe(1);
  });

  it.each([
    "id",
    "spaceId",
    "userId",
    "threadId",
    "botId",
    "taskId",
    "centralWorkspaceId",
    "workspaceMembershipVersion",
    "personalDeviceId",
  ] as const)("never retires a captured admission with a different %s", async (field) => {
    const f = await fixture();
    await f.revoke();
    const captured: Admission = { ...f.run, [field]: randomUUID() };
    await expect(
      f.tenant(() => retireWorkspaceRun({ prisma: db.prisma, events: f.events }, captured, lease)),
    ).resolves.toBe(false);
    expect(await system.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "running",
      leaseOwner: lease.owner,
      leaseFence: lease.fence,
    });
    expect(await system.attempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).toMatchObject({
      status: "running",
    });
    expect(f.publish).not.toHaveBeenCalled();
  });

  it.each(["owner", "fence"] as const)(
    "does not overwrite a successor worker's %s",
    async (field) => {
      const f = await fixture();
      const successor =
        field === "owner" ? { leaseOwner: "successor-worker" } : { leaseFence: lease.fence + 1 };
      await system.$transaction(async (tx) => {
        await declareRunReaderVersion(tx);
        await tx.run.update({ where: { id: f.run.id }, data: successor });
      });
      await f.revoke();
      await expect(
        f.tenant(() => retireWorkspaceRun({ prisma: db.prisma, events: f.events }, f.run, lease)),
      ).resolves.toBe(false);
      expect(await system.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
        status: "running",
        ...successor,
      });
      expect(f.publish).not.toHaveBeenCalled();
    },
  );

  it.each(["completed", "cancelled", "failed"])(
    "does not rewrite an already %s run",
    async (status) => {
      const f = await fixture();
      await system.run.update({ where: { id: f.run.id }, data: { status } });
      await f.revoke();
      await expect(
        f.tenant(() => retireWorkspaceRun({ prisma: db.prisma, events: f.events }, f.run, lease)),
      ).resolves.toBe(false);
      expect(await system.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
        status,
      });
      expect(f.publish).not.toHaveBeenCalled();
    },
  );

  it("retains a shared task while another admitted run remains active", async () => {
    const f = await fixture();
    const sibling = await system.run.create({
      data: {
        spaceId: f.spaceId,
        userId: f.userId,
        botId: f.botId,
        threadId: f.threadId,
        taskId: f.task.id,
        status: "queued",
        trigger: "follow_up",
      },
    });
    await f.revoke();
    await expect(
      f.tenant(() => retireWorkspaceRun({ prisma: db.prisma, events: f.events }, f.run, lease)),
    ).resolves.toBe(true);
    expect(await system.task.findUniqueOrThrow({ where: { id: f.task.id } })).toMatchObject({
      status: "running",
    });
    expect(await system.run.findUniqueOrThrow({ where: { id: sibling.id } })).toMatchObject({
      status: "queued",
    });
  });

  it("also retires a fenced legacy run whose fresh authority explicitly denied execution", async () => {
    const f = await fixture(false);
    expect(f.run).toMatchObject({ centralWorkspaceId: null, workspaceMembershipVersion: null });
    await expect(
      f.tenant(() => retireWorkspaceRun({ prisma: db.prisma, events: f.events }, f.run, lease)),
    ).resolves.toBe(true);
    expect(await system.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "cancelled",
    });
  });
});
