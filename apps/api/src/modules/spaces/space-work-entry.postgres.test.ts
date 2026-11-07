// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BackgroundJobHandlers } from "@orkbot/adapter-kit";
import {
  acquireComputerExecutionLease,
  acquireDedicatedScreenLeaseFence,
  createJobReconciler,
  createRunExecutor,
  DesktopSandboxProvider,
  handoffToGroupBot,
  LocalArtifactStore,
  messageBot,
  messageConnectedAgent,
  performComputerUpdate,
  provisionComputer,
  queueComputerUpdate,
  reconcileStrategicInitiatives,
  replaceComputer,
} from "@orkbot/adapters";
import type { Actor } from "@orkbot/contracts";
import { MessageBlock } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import {
  answerRunInput,
  asSystem,
  claimSpaceForDeletion,
  createDb,
  createThreadEvents,
  declareRunReaderVersion,
  loadRunTurnCheckpoint,
  lockSpaceForContentCreation,
  lockSpaceForWork,
  Prisma,
  provisionMessagingIdentity,
  RunHistoryWriteError,
  runAsSystem,
  runAsTenant,
  SpaceDeletionInProgressError,
  saveRunTurnCheckpoint,
  sendUserMessage,
  withTransactionRetry,
} from "@orkbot/db";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { InMemoryRealtimeFanout } from "../../../../../packages/adapters/src/realtime.js";
import { persistTurnCheckpoint } from "../../../../../packages/adapters/src/run-context.js";
import { recordEffect } from "../../../../../packages/adapters/src/run-effects.js";
import { RunStarter, RunWorkerHost } from "../../../../../packages/adapters/src/run-wakeup.js";
import { materializeCurrentTurnFiles } from "../../../../../packages/adapters/src/thread-artifacts.js";
import { restoreTurnCheckpoint } from "../../../../../packages/adapters/src/turn-checkpoint.js";
import { handleRpcError } from "../../app.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && url ? describe.sequential : describe.skip;

describePostgres("Space deletion work admission (PostgreSQL)", () => {
  const fileRoots: string[] = [];
  afterEach(async () => {
    for (const root of fileRoots.splice(0)) await rm(root, { recursive: true, force: true });
  });
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

  async function filesFixture(shared = false) {
    const root = await mkdtemp(path.join(tmpdir(), "ork-delegation-pg-"));
    fileRoots.push(root);
    const sandbox = new DesktopSandboxProvider({ root });
    const artifacts = new LocalArtifactStore(root);
    const context = {
      spaceId: identity.spaceId,
      userId: identity.userId,
      botId: sender.id,
      runId: source.id,
      operationId: source.id,
      traceId: source.id,
      signal: new AbortController().signal,
    };
    const original = await prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    const ref = await sandbox.provision({ botId: original.homeKey, homePath: "unused" }, context);
    await prisma.computer.update({
      where: { id: computerId },
      data: { kind: "desktop", providerRef: ref.providerRef, scope: shared ? "team" : "dedicated" },
    });
    const destination = shared
      ? original
      : await prisma.computer.create({
          data: {
            spaceId: identity.spaceId,
            userId: identity.userId,
            scopeKey: `fixture:${randomUUID()}`,
            scope: "dedicated",
            kind: "desktop",
            homeKey: randomUUID(),
          },
        });
    if (!shared)
      await prisma.bot.update({
        where: { id: identity.botId },
        data: { computerId: destination.id },
      });
    const filePath = shared ? `bots/${sender.id}/report.txt` : "report.txt";
    const bytes = new TextEncoder().encode("original snapshot");
    await sandbox.writeFile(ref, { path: filePath, content: bytes });
    const fileSource = {
      computerId,
      mode: shared ? ("team" as const) : ("dedicated" as const),
      computer: async () => ref,
      context,
    };
    const deps = {
      prisma: db.prisma,
      events,
      jobs,
      sandbox,
      artifacts,
      runLease: { runId: source.id, owner: "worker", fence: 1 },
    };
    return {
      root,
      sandbox,
      artifacts,
      context,
      ref,
      destination,
      fileSource,
      deps,
      bytes,
      filePath,
    };
  }

  async function readerRun(version = 1) {
    const base = await prisma.run.findUniqueOrThrow({ where: { id: queued.id } });
    return prisma.run.create({
      data: { ...base, id: randomUUID(), requiredReaderVersion: version },
    });
  }
  const claimReader = (tx: Prisma.TransactionClient, id: string, owner = "reader") =>
    tx.run.updateMany({
      where: { id, status: { in: ["queued", "leased"] } },
      data: { status: "leased", leaseOwner: owner, leaseFence: { increment: 1 } },
    });

  it("T20 reader protocol rejects legacy claims while admitting ordinary work and a current reader", async () => {
    const required = await readerRun();
    await runAsTenant(actor, async () => {
      expect(await claimReader(db.prisma, required.id)).toEqual({ count: 0 });
      expect(await claimReader(db.prisma, queued.id)).toEqual({ count: 1 });
      expect(
        await db.prisma.$transaction(async (tx) => {
          await declareRunReaderVersion(tx);
          return claimReader(tx, required.id);
        }),
      ).toEqual({ count: 1 });
      // Heartbeats and leased->running preserve the same lease and need no capability setting.
      expect(
        await db.prisma.run.updateMany({
          where: { id: required.id },
          data: { status: "running", leaseExpiresAt: new Date() },
        }),
      ).toEqual({ count: 1 });
      expect(
        await db.prisma.run.updateMany({
          where: { id: required.id },
          data: { status: "completed" },
        }),
      ).toEqual({ count: 1 });
    });
  });

  it("T20 the compatibility declaration cannot bypass RLS or admit a future protocol", async () => {
    const required = await readerRun();
    const future = await readerRun(2);
    const other = await provisionMessagingIdentity(
      prisma,
      { provider: "email", address: `reader-isolation-${randomUUID()}@example.test` },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    const otherActor: Actor = {
      userId: other.userId,
      spaceId: other.spaceId,
      email: "other@example.test",
      isDeploymentOwner: false,
    };
    await runAsTenant(otherActor, async () => {
      expect(
        await db.prisma.$transaction(async (tx) => {
          await declareRunReaderVersion(tx);
          return claimReader(tx, required.id);
        }),
      ).toEqual({ count: 0 });
      expect(await db.prisma.run.findUnique({ where: { id: required.id } })).toBeNull();
    });
    await runAsTenant(actor, async () => {
      expect(
        await db.prisma.$transaction(async (tx) => {
          await declareRunReaderVersion(tx);
          return claimReader(tx, future.id);
        }),
      ).toEqual({ count: 0 });
    });
    expect((await prisma.run.findUniqueOrThrow({ where: { id: required.id } })).status).toBe(
      "queued",
    );
  });

  it("T20 reclaim, requeue and transaction pooling never drop or leak the reader requirement", async () => {
    const required = await readerRun();
    await runAsTenant(actor, async () => {
      await db.prisma.$transaction(async (tx) => {
        await declareRunReaderVersion(tx);
        expect(await claimReader(tx, required.id)).toEqual({ count: 1 });
      });
      // An expired leased->leased claim changes its fence even though the status stays leased.
      await db.prisma.run.update({
        where: { id: required.id },
        data: { leaseExpiresAt: new Date(0) },
      });
      expect(await claimReader(db.prisma, required.id, "old-reclaim")).toEqual({ count: 0 });
      const downgraded = await db.prisma.run.update({
        where: { id: required.id },
        data: { status: "queued", requiredReaderVersion: 0 },
      });
      expect(downgraded.requiredReaderVersion).toBe(1);
      expect(await claimReader(db.prisma, required.id)).toEqual({ count: 0 });
      for (const value of ["", "-1", "1000000000", "not-a-reader"]) {
        expect(
          await db.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT set_config('app.run_reader_version', ${value}, true)`;
            return claimReader(tx, required.id);
          }),
        ).toEqual({ count: 0 });
      }
      await expect(
        db.prisma.$transaction(async (tx) => {
          await declareRunReaderVersion(tx);
          throw new Error("rollback-marker");
        }),
      ).rejects.toThrow("rollback-marker");
      // Check the next transaction on the very same backend after LOCAL has committed/rolled back.
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.run_reader_version','1',true)");
        await client.query("COMMIT");
        expect(
          (await client.query("SELECT current_setting('app.run_reader_version',true) AS value"))
            .rows[0].value,
        ).toBe("");
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.run_reader_version','1',true)");
        await client.query("ROLLBACK");
        expect(
          (await client.query("SELECT current_setting('app.run_reader_version',true) AS value"))
            .rows[0].value,
        ).toBe("");
      } finally {
        client.release();
      }
      expect(await claimReader(db.prisma, required.id)).toEqual({ count: 0 });
      expect(
        await db.prisma.$transaction(async (tx) => {
          await declareRunReaderVersion(tx);
          return claimReader(tx, required.id, "new-reclaim");
        }),
      ).toEqual({ count: 1 });
    });
  });

  it("T20 retry descendants inherit the requirement without crossing bot or thread ownership", async () => {
    const required = await readerRun();
    const { id: _id, requiredReaderVersion: _version, ...base } = required;
    await runAsTenant(actor, async () => {
      const retry = await db.prisma.run.create({
        data: { ...base, retryOfRunId: required.id },
      });
      expect(retry.requiredReaderVersion).toBe(1);
      expect(await claimReader(db.prisma, retry.id)).toEqual({ count: 0 });
      await expect(
        db.prisma.run.create({
          data: {
            ...base,
            botId: source.botId,
            threadId: source.threadId,
            retryOfRunId: required.id,
          },
        }),
      ).rejects.toThrow("Retry source is unavailable");
    });
  });

  it("T20 a legacy recovery scanner passes a full protected page without republishing or starving ordinary runs", async () => {
    const base = await prisma.run.findUniqueOrThrow({ where: { id: queued.id } });
    const ids: string[] = Array.from({ length: 101 }, () => randomUUID());
    const time = new Date(Date.now() - 10_000);
    await prisma.run.createMany({
      data: ids.map((id) => ({ ...base, id, createdAt: time, requiredReaderVersion: 1 })),
    });
    const realtime = new InMemoryRealtimeFanout();
    const publish = vi.spyOn(realtime, "publish");
    const starter = new RunStarter(realtime);
    const host = new RunWorkerHost(db.prisma, realtime, starter);
    const attempts = new Map<string, number>();
    let ordinaryClaimed = false;
    try {
      await host.start({
        "run.continue": async ({ runId }) => {
          if (runId !== queued.id && !ids.includes(runId)) return;
          attempts.set(runId, (attempts.get(runId) ?? 0) + 1);
          const result = await claimReader(prisma, runId);
          if (runId === queued.id && result.count === 1) ordinaryClaimed = true;
        },
      } as BackgroundJobHandlers);
      await vi.waitFor(
        () => {
          expect(ordinaryClaimed).toBe(true);
          expect(ids.every((id) => attempts.has(id))).toBe(true);
        },
        { timeout: 5_000, interval: 20 },
      );
    } finally {
      await host.stop();
    }
    expect(ids.every((id) => attempts.get(id) === 1)).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(
      await prisma.run.count({
        where: { id: { in: ids }, status: "queued", leaseFence: base.leaseFence },
      }),
    ).toBe(101);
  });

  it.each(["message_bot", "handoff_to_bot"])(
    "T20 %s persists source compatibility atomically before approval and crash recovery",
    async (kind) => {
      const f = await filesFixture();
      const request = { files: [f.filePath], message: "Review", bot_id: identity.botId };
      const key = randomUUID();
      await runAsTenant(actor, async () => {
        const result = await recordEffect(
          f.deps as never,
          source,
          kind,
          key,
          request,
          undefined,
          undefined,
          undefined,
          true,
        );
        expect(result.duplicate).toBe(false);
        await db.prisma.externalEffect.update({
          where: { id: result.effect.id },
          data: { status: "waiting" },
        });
        expect(await db.prisma.run.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({
          requiredReaderVersion: 1,
        });
        // Crash/requeue before approval delivery: an older executable must not replay the new args.
        await db.prisma.run.update({ where: { id: source.id }, data: { status: "queued" } });
        expect(await claimReader(db.prisma, source.id)).toEqual({ count: 0 });
        expect(
          await db.prisma.$transaction(async (tx) => {
            await declareRunReaderVersion(tx);
            return claimReader(tx, source.id);
          }),
        ).toEqual({ count: 1 });
        expect(
          (await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: result.effect.id } }))
            .request,
        ).toEqual(request);
      });
    },
  );

  it("T20 source version and effect roll back together, reject stale fences, and admit parallel file effects", async () => {
    const f = await filesFixture();
    await runAsTenant(actor, async () => {
      const broken = {
        ...f.deps,
        prisma: {
          ...db.prisma,
          $transaction: (write: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
            db.prisma.$transaction((tx) =>
              write(
                new Proxy(tx, {
                  get(target, property) {
                    if (property === "externalEffect")
                      return {
                        ...target.externalEffect,
                        create: async () => {
                          throw new Error("effect-write-failed");
                        },
                      };
                    return Reflect.get(target, property);
                  },
                }),
              ),
            ),
        },
      };
      await expect(
        recordEffect(
          broken as never,
          source,
          "message_bot",
          randomUUID(),
          { files: [f.filePath] },
          undefined,
          undefined,
          undefined,
          true,
        ),
      ).rejects.toThrow("effect-write-failed");
      expect(
        (await db.prisma.run.findUniqueOrThrow({ where: { id: source.id } })).requiredReaderVersion,
      ).toBe(0);
      const stale = { ...f.deps, runLease: { ...f.deps.runLease, fence: 0 } };
      const key = randomUUID();
      await expect(
        recordEffect(
          stale as never,
          source,
          "message_bot",
          key,
          { files: [f.filePath] },
          undefined,
          undefined,
          undefined,
          true,
        ),
      ).rejects.toBeInstanceOf(RunHistoryWriteError);
      expect(await db.prisma.externalEffect.count({ where: { idempotencyKey: key } })).toBe(0);
      await Promise.all(
        [1, 2].map(() =>
          recordEffect(
            f.deps as never,
            source,
            "message_bot",
            randomUUID(),
            { files: [f.filePath] },
            undefined,
            undefined,
            undefined,
            true,
          ),
        ),
      );
      expect(
        (await db.prisma.run.findUniqueOrThrow({ where: { id: source.id } })).requiredReaderVersion,
      ).toBe(1);
    });
  });

  it.each([false, true])(
    "T20 unresolved sequential file tail (wrapped=%s) fences checkpoint and survives resume",
    async (wrapped) => {
      const f = await filesFixture();
      const fileCall = {
        type: "toolCall",
        id: "file-tail",
        name: wrapped ? "use_tool" : "message_bot",
        arguments: wrapped
          ? { name: "message_bot", arguments: { files: [f.filePath] } }
          : { files: [f.filePath] },
      };
      const saved = {
        version: 1,
        provider: "fixture",
        model: "fixture",
        systemPrompt: "fixture",
        executionMode: "sequential",
        pendingToolCallId: "secret-pause",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "secret-pause", name: "request_secret", arguments: {} },
              fileCall,
            ],
          },
        ],
      };
      await runAsTenant(actor, async () => {
        const ctx = {
          deps: f.deps,
          run: source,
          workerId: "worker",
          fence: 1,
          state: {
            effects: {
              pendingTurnCheckpoints: new Map([["secret-pause", () => JSON.stringify(saved)]]),
              occurrences: [],
            },
          },
        };
        await persistTurnCheckpoint(ctx as never, "secret-pause");
        expect(
          (await db.prisma.run.findUniqueOrThrow({ where: { id: source.id } }))
            .requiredReaderVersion,
        ).toBe(1);
        const stored = await loadRunTurnCheckpoint(db.prisma, source);
        expect(
          restoreTurnCheckpoint(stored!, { provider: "fixture", id: "fixture" }).messages[0],
        ).toEqual(saved.messages[0]);
        await db.prisma.run.update({ where: { id: source.id }, data: { status: "queued" } });
        expect(await claimReader(db.prisma, source.id)).toEqual({ count: 0 });
        expect(
          await db.prisma.$transaction(async (tx) => {
            await declareRunReaderVersion(tx);
            return claimReader(tx, source.id);
          }),
        ).toEqual({ count: 1 });
      });
    },
  );

  it("T20 checkpoint write failure rolls back its source version and stale checkpoints cannot upgrade", async () => {
    await runAsTenant(actor, async () => {
      const stale = saveRunTurnCheckpoint(db.prisma, source, "worker", 0, "checkpoint", 1);
      await expect(stale).rejects.toThrow("Run lease expired");
      expect(
        (await db.prisma.run.findUniqueOrThrow({ where: { id: source.id } })).requiredReaderVersion,
      ).toBe(0);
      const broken = new Proxy(db.prisma, {
        get(target, property) {
          if (property === "$transaction")
            return (write: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
              db.prisma.$transaction((tx) =>
                write(
                  new Proxy(tx, {
                    get(inner, key) {
                      if (key === "externalEffect")
                        return {
                          ...inner.externalEffect,
                          upsert: async () => {
                            throw new Error("checkpoint-write-failed");
                          },
                        };
                      return Reflect.get(inner, key);
                    },
                  }),
                ),
              );
          return Reflect.get(target, property);
        },
      });
      await expect(
        saveRunTurnCheckpoint(broken, source, "worker", 1, "checkpoint", 1),
      ).rejects.toThrow("checkpoint-write-failed");
      expect(
        (await db.prisma.run.findUniqueOrThrow({ where: { id: source.id } })).requiredReaderVersion,
      ).toBe(0);
      expect(await loadRunTurnCheckpoint(db.prisma, source)).toBeUndefined();
    });
  });

  it("T20 handoff from outside the group rejects a source lease replaced during file preparation", async () => {
    const f = await filesFixture();
    const targetThread = await prisma.thread.findFirstOrThrow({
      where: { groupId, spaceId: source.spaceId, userId: source.userId },
    });
    const deliveryKey = "stale-source-delivery";
    const read = f.sandbox.readTransferFile.bind(f.sandbox);
    vi.spyOn(f.sandbox, "readTransferFile").mockImplementation(async (...args) => {
      const result = await read(...args);
      await prisma.run.update({
        where: { id: source.id },
        data: { leaseOwner: "replacement", leaseFence: 2 },
      });
      return result;
    });
    await runAsTenant(actor, async () => {
      await expect(
        handoffToGroupBot(
          f.deps,
          source,
          groupId,
          { bot_id: identity.botId, message: "Review", files: [f.filePath], deliveryKey },
          { fileSource: f.fileSource },
        ),
      ).rejects.toBeInstanceOf(RunHistoryWriteError);
    });
    expect(await prisma.artifact.count({ where: { runId: source.id } })).toBe(0);
    expect(
      await prisma.message.count({
        where: { threadId: targetThread.id, clientNonce: `group-handoff:${deliveryKey}` },
      }),
    ).toBe(0);
    expect(
      await prisma.run.count({
        where: { threadId: targetThread.id, trigger: "follow_up", botId: identity.botId },
      }),
    ).toBe(0);
  });

  it("T20 atomically delivers one immutable file snapshot across computers and concurrent replays", async () => {
    const f = await filesFixture();
    const read = vi.spyOn(f.sandbox, "readTransferFile");
    const deliver = () =>
      runAsTenant(actor, () =>
        messageBot(
          f.deps,
          source,
          sender,
          {
            bot_id: identity.botId,
            message: "Review",
            deliveryKey: "file-effect",
            files: [f.filePath],
          },
          { fileSource: f.fileSource },
        ),
      );
    const results = await Promise.all([deliver(), deliver()]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await prisma.artifact.count({ where: { spaceId: identity.spaceId } })).toBe(1);
    expect(
      await prisma.message.count({
        where: { threadId: identity.threadId, clientNonce: "bot-message:file-effect" },
      }),
    ).toBe(1);
    expect(await readdir(path.join(f.root, "artifacts", identity.spaceId))).toHaveLength(1);
    expect(f.sandbox.boxes.size).toBe(1);
    const sourceReads = read.mock.calls.length;
    await f.sandbox.writeFile(f.ref, {
      path: f.filePath,
      content: new TextEncoder().encode("changed"),
    });
    expect(await deliver()).toMatchObject({ ok: true, replayed: true });
    expect(read).toHaveBeenCalledTimes(sourceReads);
    const inbound = await prisma.message.findFirstOrThrow({
      where: { threadId: identity.threadId, clientNonce: "bot-message:file-effect" },
    });
    const blocks = MessageBlock.array().parse(inbound.blocks);
    expect(blocks.map((block) => block.kind)).toEqual(["bot_message_received", "file"]);
    const copied = await runAsTenant(actor, () =>
      materializeCurrentTurnFiles(
        { prisma: db.prisma, artifacts: f.artifacts, sandbox: f.sandbox },
        blocks,
        {
          context: { ...f.context, botId: identity.botId },
          computerMode: "dedicated",
          computer: () =>
            f.sandbox.provision({ botId: f.destination.homeKey, homePath: "unused" }, f.context),
        },
      ),
    );
    const receiver = await f.sandbox.provision(
      { botId: f.destination.homeKey, homePath: "unused" },
      f.context,
    );
    expect(await f.sandbox.readFile(receiver, copied[0]!.path, f.context)).toEqual(f.bytes);
    expect(f.sandbox.boxes.size).toBe(2);
  });

  it("T20 group handoff publishes ordinary attachment blocks live and keeps its original event", async () => {
    const f = await filesFixture();
    const result = await runAsTenant(actor, () =>
      handoffToGroupBot(
        f.deps,
        source,
        groupId,
        {
          bot_id: identity.botId,
          message: "Review",
          deliveryKey: "group-files",
          files: [f.filePath],
        },
        { fileSource: f.fileSource },
      ),
    );
    expect(result).toMatchObject({ ok: true });
    const thread = await prisma.thread.findFirstOrThrow({ where: { groupId } });
    const live = await prisma.event.findMany({
      where: { threadId: thread.id },
      orderBy: { seq: "asc" },
    });
    expect(live.map((event) => event.type)).toEqual(["thread.message.created", "group.handoff"]);
    expect(live[0]?.payload).toMatchObject({
      role: "bot",
      blocks: [
        expect.objectContaining({ kind: "handoff" }),
        expect.objectContaining({ kind: "file" }),
      ],
    });
    expect(
      await prisma.artifact.findFirstOrThrow({ where: { spaceId: identity.spaceId } }),
    ).toMatchObject({ botId: identity.botId, groupId });
  });

  it("T20 retains authorized shared-computer paths without copying artifact objects", async () => {
    const f = await filesFixture(true);
    expect(
      await runAsTenant(actor, () =>
        messageBot(
          f.deps,
          source,
          sender,
          {
            bot_id: identity.botId,
            message: "Review",
            deliveryKey: "shared-files",
            files: [f.filePath],
          },
          { fileSource: f.fileSource },
        ),
      ),
    ).toMatchObject({ ok: true });
    expect(await prisma.artifact.count({ where: { spaceId: identity.spaceId } })).toBe(0);
    const inbound = await prisma.message.findFirstOrThrow({
      where: { threadId: identity.threadId, clientNonce: "bot-message:shared-files" },
    });
    expect(inbound.blocks).toEqual([
      expect.objectContaining({
        kind: "bot_message_received",
        workspaceFiles: {
          computerId,
          version: expect.stringMatching(/^[a-f0-9]{64}$/u),
          paths: [f.filePath],
        },
      }),
    ]);
    expect(JSON.stringify(inbound.blocks)).not.toContain(f.ref.providerRef);
  });

  it("T20 cancellation during file IO cannot commit a delivery or leave its prepared object", async () => {
    const f = await filesFixture();
    const read = f.sandbox.readTransferFile.bind(f.sandbox);
    vi.spyOn(f.sandbox, "readTransferFile").mockImplementationOnce(async (...args) => {
      const bytes = await read(...args);
      await prisma.run.update({ where: { id: source.id }, data: { status: "cancelled" } });
      return bytes;
    });
    expect(
      await runAsTenant(actor, () =>
        messageBot(
          f.deps,
          source,
          sender,
          {
            bot_id: identity.botId,
            message: "Review",
            deliveryKey: "cancelled-files",
            files: [f.filePath],
          },
          { fileSource: f.fileSource },
        ),
      ),
    ).toMatchObject({ ok: false });
    expect(await prisma.artifact.count({ where: { spaceId: identity.spaceId } })).toBe(0);
    expect(
      await prisma.message.count({
        where: { threadId: identity.threadId, clientNonce: "bot-message:cancelled-files" },
      }),
    ).toBe(0);
    expect(await readdir(path.join(f.root, "artifacts", identity.spaceId))).toEqual([]);
  });

  it("T20 denies cross-Space direct and group file delivery before reading any source", async () => {
    const f = await filesFixture();
    const ownSpace = await prisma.space.findUniqueOrThrow({ where: { id: identity.spaceId } });
    const otherSpaceId = randomUUID();
    await prisma.space.create({
      data: {
        id: otherSpaceId,
        organizationId: ownSpace.organizationId,
        name: "Other fixture Space",
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: otherSpaceId,
        organizationId: ownSpace.organizationId,
        userId: identity.userId,
        createdAt: new Date(),
      },
    });
    const other = await prisma.bot.create({
      data: { spaceId: otherSpaceId, userId: identity.userId, name: "Other", color: "blue" },
    });
    await prisma.thread.create({
      data: { spaceId: otherSpaceId, userId: identity.userId, botId: other.id },
    });
    const group = await prisma.chatGroup.create({
      data: {
        spaceId: otherSpaceId,
        userId: identity.userId,
        name: "Other group",
        members: { create: [{ botId: other.id }, { botId: sender.id }] },
      },
    });
    await prisma.thread.create({
      data: { spaceId: otherSpaceId, userId: identity.userId, groupId: group.id },
    });
    const read = vi.spyOn(f.sandbox, "readTransferFile");
    expect(
      await runAsTenant(actor, () =>
        messageBot(
          f.deps,
          source,
          sender,
          { bot_id: other.id, message: "Review", deliveryKey: "cross-space", files: [f.filePath] },
          { fileSource: f.fileSource },
        ),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await runAsTenant(actor, () =>
        handoffToGroupBot(
          f.deps,
          source,
          group.id,
          { bot_id: other.id, message: "Review", files: [f.filePath] },
          { fileSource: f.fileSource },
        ),
      ),
    ).toHaveProperty("error");
    expect(read).not.toHaveBeenCalled();
    expect(await prisma.artifact.count({ where: { runId: source.id } })).toBe(0);
  });

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
