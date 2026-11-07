// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import {
  acquireComputerExecutionLease,
  acquireDedicatedScreenLeaseFence,
  createJobReconciler,
  createRunExecutor,
  handoffToGroupBot,
  messageBot,
  messageConnectedAgent,
  performComputerUpdate,
  provisionComputer,
  queueComputerUpdate,
  reconcileStrategicInitiatives,
  replaceComputer,
} from "@orkbot/adapters";
import type { Actor } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import {
  answerRunInput,
  asSystem,
  claimSpaceForDeletion,
  createDb,
  createThreadEvents,
  lockSpaceForContentCreation,
  lockSpaceForWork,
  Prisma,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
  SpaceDeletionInProgressError,
  sendUserMessage,
  withTransactionRetry,
} from "@orkbot/db";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMcpApprovalCards } from "#modules/mcp/mcp-approval";
import { deliverWebhookEvent } from "#modules/messaging/webhook-inbound";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";
import { createRoutineTestRun } from "#modules/routines/routines";
import {
  reactToThreadMessage,
  resolveThreadTarget,
  sendThreadMessage,
} from "#modules/threads/thread-target";
import { handleRpcError } from "../../app.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && url ? describe.sequential : describe.skip;

describePostgres("Space deletion work admission (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let actor: Actor;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  let sender: { id: string; name: string; threadId: string };
  let source: { id: string; spaceId: string; threadId: string; botId: string; userId: string };
  let queued: { id: string; taskId: string };
  let computerId: string;
  let routine: Awaited<ReturnType<PrismaClient["routine"]["create"]>>;
  let failed: { id: string };
  let updateId: string;
  let messageId: string;
  let groupId: string;
  let deletionSpaceId: string;
  let peer: typeof identity | undefined;
  let peerAddress: string;
  let connectionId: string | undefined;
  let events: ReturnType<typeof createThreadEvents>;
  let resolvedTarget: Awaited<ReturnType<typeof resolveThreadTarget>>;
  const jobs = {
    enqueue: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const providerCall = vi.fn(async () => {
    throw new Error("Unexpected provider call");
  });

  beforeAll(() => {
    db = createDb(url!);
    prisma = asSystem(db.prisma);
  });
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    peer = undefined;
    connectionId = undefined;
    const provisioned = await provisionMessagingIdentity(
      prisma,
      { provider: "email", address: `space-work-${randomUUID()}@example.test` },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    const { userId, spaceId, botId, threadId } = provisioned;
    identity = { userId, spaceId, botId, threadId };
    deletionSpaceId = spaceId;
    actor = { userId, spaceId, email: "fixture@example.test", isDeploymentOwner: false };
    const bot = await prisma.bot.findUniqueOrThrow({ where: { id: identity.botId } });
    computerId = bot.computerId!;
    await prisma.computer.update({
      where: { id: computerId },
      data: { kind: "fake", scope: "team" },
    });
    await prisma.run.updateMany({
      where: { spaceId: identity.spaceId },
      data: { status: "cancelled" },
    });
    const senderBot = await prisma.bot.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        name: "Sender",
        color: "blue",
        computerId,
      },
    });
    const senderThread = await prisma.thread.create({
      data: { spaceId: identity.spaceId, userId: identity.userId, botId: senderBot.id },
    });
    sender = { id: senderBot.id, name: senderBot.name, threadId: senderThread.id };
    const group = await prisma.chatGroup.create({
      data: {
        spaceId,
        userId,
        name: "Fixture group",
        members: { create: [{ botId }, { botId: sender.id }] },
      },
    });
    groupId = group.id;
    await prisma.thread.create({ data: { spaceId, userId, groupId } });
    const createRun = async (
      status: string,
      botId = identity.botId,
      threadId = identity.threadId,
    ) => {
      const task = await prisma.task.create({
        data: {
          spaceId: identity.spaceId,
          userId: identity.userId,
          botId,
          threadId,
          prompt: "fixture",
          status,
        },
      });
      return prisma.run.create({
        data: {
          spaceId: identity.spaceId,
          userId: identity.userId,
          botId,
          threadId,
          taskId: task.id,
          status,
          trigger: "user",
          leaseOwner: status === "running" ? "worker" : null,
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 300_000),
          checkpoint: "preserved-checkpoint",
        },
      });
    };
    source = await createRun("running", sender.id, sender.threadId);
    queued = await createRun("queued");
    const dueAt = new Date(Date.now() - 60_000);
    routine = await prisma.routine.create({
      data: {
        ...identity,
        name: "Check",
        prompt: "fixture",
        crons: ["0 9 * * *"],
        active: true,
        nextRunAt: dueAt,
      },
    });
    const retryTask = await prisma.task.create({
      data: { ...identity, prompt: "retry fixture", status: "failed" },
    });
    failed = await prisma.run.create({
      data: {
        ...identity,
        taskId: retryTask.id,
        status: "failed",
        trigger: "routine",
        routineId: routine.id,
      },
    });
    const update = await prisma.computerUpdate.create({
      data: { computerId, botId: identity.botId },
    });
    updateId = update.id;
    const message = await prisma.message.create({
      data: {
        threadId: identity.threadId,
        seq: 100,
        role: "bot",
        botId: identity.botId,
        blocks: [{ kind: "text", text: "fixture" }],
      },
    });
    messageId = message.id;
    events = createThreadEvents(prisma);
    resolvedTarget = await resolveThreadTarget(prisma, actor, { botId: identity.botId });
    return async () => {
      if (connectionId) await prisma.agentConnection.deleteMany({ where: { id: connectionId } });
      if (peer) {
        await prisma.organization.deleteMany({ where: { id: peer.spaceId } });
        await prisma.user.deleteMany({ where: { id: peer.userId } });
      }
      await prisma.organization.deleteMany({ where: { id: identity.spaceId } });
      await prisma.user.deleteMany({ where: { id: identity.userId } });
    };
  });

  const executor = () =>
    createRunExecutor({ prisma, jobs, events } as unknown as Parameters<
      typeof createRunExecutor
    >[0]);
  const computerDeps = () =>
    ({
      prisma,
      jobs,
      events,
      sandbox: { provision: providerCall, destroy: providerCall },
      home: {},
    }) as unknown as Parameters<typeof replaceComputer>[0];
  const target = () => resolvedTarget;

  async function prepareConnectedMessage(deletingRecipient: boolean) {
    peerAddress = `space-work-peer-${randomUUID()}@example.test`;
    const provisioned = await provisionMessagingIdentity(
      prisma,
      { provider: "email", address: peerAddress },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    const { userId, spaceId, botId, threadId } = provisioned;
    peer = { userId, spaceId, botId, threadId };
    await prisma.messagingIdentity.create({
      data: {
        userId: identity.userId,
        spaceId: identity.spaceId,
        botId: sender.id,
        provider: "email",
        address: `space-work-sender-${randomUUID()}@example.test`,
      },
    });
    const connection = await prisma.agentConnection.create({
      data: { requesterBotId: sender.id, targetBotId: botId, status: "approved" },
    });
    connectionId = connection.id;
    if (deletingRecipient) deletionSpaceId = spaceId;
  }

  async function groupFollowUp() {
    const deps = {
      prisma: db.prisma,
      jobs,
      events,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "https://web.example.test",
      },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps), {
      clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
    });
    const { response } = await handler.handle(
      new Request("https://api.example.test/rpc/threads/followUp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { groupId, text: "new follow-up" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  const entries: Array<readonly [string, () => Promise<unknown>, (() => Promise<void>)?]> = [
    [
      "shared send",
      () =>
        sendUserMessage(prisma, {
          ...identity,
          blocks: [{ kind: "text", text: "new" }],
          prompt: "new",
          trigger: "user",
        }),
    ],
    [
      "native client send",
      () =>
        sendThreadMessage(
          { prisma, jobs, events, sandbox: {} } as unknown as Parameters<
            typeof sendThreadMessage
          >[0],
          actor,
          target(),
          { text: "new" },
        ),
    ],
    [
      "native reaction",
      () =>
        reactToThreadMessage({ prisma, jobs }, actor, target(), {
          messageId,
          reaction: "👍",
          clientNonce: randomUUID(),
          mayStartTurn: true,
        }),
    ],
    [
      "routine-only send",
      () =>
        prisma.$transaction((tx) =>
          createRoutineTestRun(
            tx,
            actor,
            { routine, botId: identity.botId, threadId: identity.threadId } as Parameters<
              typeof createRoutineTestRun
            >[2],
            "new",
            undefined,
          ),
        ),
    ],
    [
      "approval answer",
      () =>
        runAsSystem("Space admission answer fixture", () =>
          answerRunInput(db.prisma, {
            spaceId: identity.spaceId,
            threadId: identity.threadId,
            runId: queued.id,
            messageId,
            answer: "yes",
            answeredByUserId: identity.userId,
          }),
        ),
    ],
    [
      "webhook",
      () =>
        deliverWebhookEvent(
          { events, jobs },
          {
            bot: { id: identity.botId, spaceId: identity.spaceId, userId: identity.userId },
            threadId: identity.threadId,
          },
          { prompt: "new", routines: [], source: "webhook" },
        ),
    ],
    [
      "bot message",
      () =>
        messageBot({ prisma, events, jobs }, source, sender, {
          bot_id: identity.botId,
          message: "new",
        }),
    ],
    [
      "MCP connection approval",
      () =>
        runAsTenant(actor, () =>
          resolveMcpApprovalCards(
            { prisma: db.prisma, events },
            actor,
            { botId: identity.botId, serverId: "fixture-server", status: "connected" },
            async () => {
              throw new Error("Unexpected MCP credential write");
            },
          ),
        ),
    ],
    ["group follow-up", groupFollowUp],
    [
      "group handoff",
      () =>
        handoffToGroupBot({ prisma, events, jobs }, source, groupId, {
          bot_id: identity.botId,
          message: "new",
        }),
    ],
    [
      "connected agent sender Space",
      () =>
        messageConnectedAgent({ prisma, events, jobs }, source, sender, {
          address: peerAddress,
          message: "new",
        }),
      () => prepareConnectedMessage(false),
    ],
    [
      "connected agent recipient Space",
      () =>
        messageConnectedAgent({ prisma, events, jobs }, source, sender, {
          address: peerAddress,
          message: "new",
        }),
      () => prepareConnectedMessage(true),
    ],
    [
      "strategic initiative",
      () =>
        reconcileStrategicInitiatives({
          prisma,
          jobs,
          billingEnabled: false,
          now: new Date(),
          pageSize: 100,
        }),
      async () => {
        await prisma.run.update({ where: { id: source.id }, data: { status: "completed" } });
        await prisma.scratchpadItem.create({
          data: {
            spaceId: identity.spaceId,
            userId: identity.userId,
            botId: sender.id,
            title: "Synthetic stale work",
            notes: "Fixture",
            updatedAt: new Date(Date.now() - 48 * 60 * 60_000),
          },
        });
      },
    ],
    ["routine wake", () => executor().wakeRoutine(routine.id, routine.nextRunAt!.toISOString())],
    [
      "routine retry",
      async () => {
        await prisma.routine.update({
          where: { id: routine.id },
          data: { nextRunAt: new Date(Date.now() + 24 * 60 * 60_000) },
        });
        return executor().retryRoutineRun(failed.id);
      },
    ],
    ["executor lease", () => executor().continueRun(queued.id, "new-worker")],
    [
      "computer update request",
      () => queueComputerUpdate(computerDeps(), computerId, identity.botId),
    ],
    ["computer update execution", () => performComputerUpdate(computerDeps(), updateId)],
    [
      "computer provisioning",
      () =>
        provisionComputer(computerDeps(), computerId, {
          operationId: "provision",
          traceId: "provision",
          ...actor,
          botId: identity.botId,
          signal: new AbortController().signal,
        }),
    ],
    [
      "computer replacement",
      () =>
        replaceComputer(computerDeps(), computerId, "reset", {
          operationId: "replace",
          traceId: "replace",
          ...actor,
          botId: identity.botId,
          signal: new AbortController().signal,
        }),
    ],
    [
      "computer execution lease",
      () =>
        acquireComputerExecutionLease(prisma, {
          computerId,
          botId: identity.botId,
          runId: queued.id,
        }),
    ],
    [
      "dedicated screen lease",
      () =>
        acquireDedicatedScreenLeaseFence(prisma, {
          computerId,
          botId: identity.botId,
          runId: queued.id,
          workerId: "new-worker",
          runFence: 1,
        }),
    ],
  ];

  it.each(entries.map(([name, enter, prepare]) => ({ name, enter, prepare })))(
    "serializes $name with a deletion claim",
    async ({ name, enter, prepare }) => {
      await prepare?.();
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let deletionPid = 0;
      const deletion = prisma.$transaction(
        async (tx) => {
          await claimSpaceForDeletion(tx, deletionSpaceId, "deletion-race");
          const [backend] = await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          deletionPid = backend!.pid;
          entered();
          await held;
        },
        { timeout: 20_000 },
      );
      await reached;
      const before = await prisma.run.count({ where: { spaceId: identity.spaceId } });
      // Attach rejection handling immediately while the actual admission waits for the lock.
      const attempt = Promise.resolve()
        .then(enter)
        .then(
          (value) => ({ error: undefined as unknown, value }),
          (error: unknown) => ({ error, value: undefined }),
        );
      try {
        await expect
          .poll(
            async () => {
              const [row] = await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) FROM pg_stat_activity
          WHERE ${deletionPid} = ANY(pg_blocking_pids(pid))
            AND datname = current_database()
        `;
              return Number(row!.count);
            },
            { timeout: 10_000 },
          )
          .toBeGreaterThan(0);
      } catch (waitError) {
        release();
        await deletion;
        const result = await attempt;
        throw new Error(`Work entry did not wait: ${name}: ${String(result.error)}`, {
          cause: waitError,
        });
      } finally {
        release();
        await deletion;
      }
      const { error, value } = await attempt;
      if (name === "webhook") expect(error).toMatchObject({ status: 409 });
      else if (name === "group follow-up") {
        expect(error).toBeUndefined();
        expect(value).toMatchObject({ status: 409 });
      } else if (name === "strategic initiative") {
        expect(error).toBeUndefined();
        expect(value).toBe(0);
      } else if (name === "routine retry") {
        expect(error).toBeUndefined();
        expect(jobs.enqueue).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "routine.retry",
            payload: { runId: failed.id },
            replaceKey: `routine.retry:${failed.id}`,
            availableAt: expect.any(Date),
          }),
        );
      } else expect(error).toBeInstanceOf(SpaceDeletionInProgressError);
      expect(await prisma.run.count({ where: { spaceId: identity.spaceId } })).toBe(before);
      expect(await prisma.run.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({
        status: "queued",
        checkpoint: "preserved-checkpoint",
        leaseOwner: null,
      });
      expect(
        await prisma.computerUpdate.findUniqueOrThrow({ where: { id: updateId } }),
      ).toMatchObject({ status: "queued" });
      expect(await prisma.computerExecutionLease.count({ where: { computerId } })).toBe(0);
      if (name !== "routine retry") expect(jobs.enqueue).not.toHaveBeenCalled();
      expect(providerCall).not.toHaveBeenCalled();
    },
  );

  it("allows concurrent Space admissions while an exclusive deletion waits", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let admissions = 0;
    const work = () =>
      prisma.$transaction(
        async (tx) => {
          await lockSpaceForWork(tx, identity.spaceId);
          admissions += 1;
          await held;
        },
        { timeout: 20_000 },
      );
    const first = work();
    const second = work();
    let deletion: Promise<unknown> | undefined;
    try {
      await expect.poll(() => admissions, { timeout: 10_000 }).toBe(2);
      deletion = prisma.$transaction((tx) =>
        claimSpaceForDeletion(tx, identity.spaceId, "wait-for-admission"),
      );
      await expect
        .poll(async () => {
          const [row] = await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        `;
          return Number(row!.count);
        })
        .toBeGreaterThan(0);
      expect(
        await prisma.space.findUniqueOrThrow({ where: { id: identity.spaceId } }),
      ).toMatchObject({ deletingAt: null });
    } finally {
      release();
      await Promise.all([first, second]);
      await deletion;
    }
    expect(await prisma.space.findUniqueOrThrow({ where: { id: identity.spaceId } })).toMatchObject(
      { deletionClaimId: "wait-for-admission" },
    );
  });

  it.each(["work", "content creation"] as const)(
    "rejects %s whose serializable snapshot predates the deletion claim",
    async (kind) => {
      const groupsBefore = await prisma.chatGroup.count({ where: { spaceId: identity.spaceId } });
      let reached!: () => void;
      let resume!: () => void;
      const observed = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const held = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const admission = withTransactionRetry(() =>
        prisma.$transaction(
          async (tx) => {
            await tx.space.findUniqueOrThrow({ where: { id: identity.spaceId } });
            reached();
            await held;
            if (kind === "work") await lockSpaceForWork(tx, identity.spaceId);
            else
              await lockSpaceForContentCreation(tx, {
                spaceId: identity.spaceId,
                userId: identity.userId,
              });
            await tx.chatGroup.create({
              data: {
                spaceId: identity.spaceId,
                userId: identity.userId,
                name: "Must not be created",
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
      // Register both outcomes before releasing the old snapshot.
      const outcome = admission.then(
        () => undefined,
        (error: unknown) => error,
      );
      await observed;
      try {
        await prisma.$transaction((tx) =>
          claimSpaceForDeletion(tx, identity.spaceId, "snapshot-race"),
        );
      } finally {
        resume();
      }
      expect(await outcome).toBeInstanceOf(SpaceDeletionInProgressError);
      expect(await prisma.chatGroup.count({ where: { spaceId: identity.spaceId } })).toBe(
        groupsBefore,
      );
    },
  );

  it("keeps accepted continuations recoverable after deletion is cancelled", async () => {
    await prisma.routine.update({
      where: { id: routine.id },
      data: { nextRunAt: new Date(Date.now() + 24 * 60 * 60_000) },
    });
    await prisma.$transaction((tx) =>
      claimSpaceForDeletion(tx, identity.spaceId, "cancelled-deletion"),
    );
    await expect(executor().continueRun(queued.id, "new-worker")).rejects.toThrow(
      SpaceDeletionInProgressError,
    );
    await expect(performComputerUpdate(computerDeps(), updateId)).rejects.toThrow(
      SpaceDeletionInProgressError,
    );
    await executor().retryRoutineRun(failed.id);
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "routine.retry",
        payload: { runId: failed.id },
        replaceKey: `routine.retry:${failed.id}`,
      }),
    );
    expect(await prisma.run.count({ where: { retryOfRunId: failed.id } })).toBe(0);
    await prisma.space.update({
      where: { id: identity.spaceId },
      data: { deletingAt: null, deletionClaimId: null },
    });
    await executor().retryRoutineRun(failed.id);
    expect(await prisma.run.count({ where: { retryOfRunId: failed.id } })).toBe(1);
    const reconcile = createJobReconciler({ prisma, jobs });
    await reconcile.reconcileOnce();
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: queued.id } }),
    );
    expect(await prisma.run.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({
      status: "queued",
      checkpoint: "preserved-checkpoint",
    });
    expect(
      await prisma.computerUpdate.findUniqueOrThrow({ where: { id: updateId } }),
    ).toMatchObject({ status: "queued" });
  });
});
