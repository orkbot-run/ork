// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { MessageBlock, RunTriggerSchema } from "@orkbot/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelBackgroundHelper,
  createBackgroundHelper,
  expireStuckBackgroundHelper,
  findBackgroundHelper,
  returnBackgroundHelperOutcome,
  updateBackgroundHelperProgress,
} from "./background-helpers.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { claimSteering, clearThread } from "./events.js";
import { createThreadMessage } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";
import { BACKGROUND_HELPER_READER_VERSION } from "./run-reader-version.js";
import { recordUsage } from "./usage.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

describePostgres("background helper admission (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  let parentRunId: string;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const task = await system.task.create({
      data: {
        spaceId: identity.spaceId,
        botId: identity.botId,
        threadId: identity.threadId,
        userId: identity.userId,
        prompt: "parent",
        status: "running",
      },
    });
    const run = await system.run.create({
      data: {
        spaceId: identity.spaceId,
        botId: identity.botId,
        threadId: identity.threadId,
        userId: identity.userId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker",
        leaseFence: 1,
      },
    });
    parentRunId = run.id;
  });

  afterAll(async () => {
    try {
      if (system && identity) {
        await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await system.organization.deleteMany({ where: { id: identity.spaceId } });
        await system.user.deleteMany({ where: { id: identity.userId } });
      }
    } finally {
      await close?.();
    }
  });

  it("serializes repeated calls and fences old workers", async () => {
    const input = {
      spaceId: identity.spaceId,
      parentThreadId: identity.threadId,
      parentRunId,
      parentLease: { owner: "worker", fence: 1 },
      callId: "call-1",
      name: "helper",
      task: "Inspect the report",
    };
    const tenant = { spaceId: identity.spaceId, userId: identity.userId };
    const [first, second] = await Promise.all([
      runAsTenant(tenant, () => createBackgroundHelper(prisma, input)),
      runAsTenant(tenant, () => createBackgroundHelper(prisma, input)),
    ]);
    expect(first.threadId).toBe(second.threadId);
    expect(first.runId).toBe(second.runId);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    const unsafeParent = await system.run.create({
      data: {
        spaceId: identity.spaceId,
        botId: identity.botId,
        threadId: identity.threadId,
        userId: identity.userId,
        taskId: (await system.run.findUniqueOrThrow({ where: { id: parentRunId } })).taskId,
        status: "running",
        trigger: "messaging",
        leaseOwner: "worker",
        leaseFence: 1,
      },
    });
    await expect(
      runAsTenant(tenant, () =>
        createBackgroundHelper(prisma, {
          ...input,
          parentRunId: unsafeParent.id,
          callId: "external-source",
        }),
      ),
    ).rejects.toThrow("not the bot owner's app conversation");
    await system.run.update({ where: { id: unsafeParent.id }, data: { status: "completed" } });
    const child = await system.run.findUniqueOrThrow({ where: { id: first.runId } });
    expect(child).toMatchObject({
      status: "queued",
      trigger: "tickets",
      requiredReaderVersion: BACKGROUND_HELPER_READER_VERSION,
    });
    expect(RunTriggerSchema.parse(child.trigger)).toBe("tickets");
    const legacyClaim = await system.run.updateMany({
      where: { id: first.runId },
      data: { status: "leased", leaseOwner: "old" },
    });
    expect(legacyClaim.count).toBe(0);
    await expect(
      runAsTenant(tenant, () =>
        createBackgroundHelper(prisma, {
          ...input,
          callId: "call-2",
          parentLease: { owner: "worker", fence: 0 },
        }),
      ),
    ).rejects.toThrow();
    expect(await system.thread.count({ where: { parentRunId } })).toBe(1);
    const parallel = await Promise.all([
      runAsTenant(tenant, () => createBackgroundHelper(prisma, { ...input, callId: "parallel-1" })),
      runAsTenant(tenant, () => createBackgroundHelper(prisma, { ...input, callId: "parallel-2" })),
    ]);
    expect(parallel[0]?.runId).not.toBe(parallel[1]?.runId);
    const card = await system.message.findUniqueOrThrow({
      where: {
        threadId_clientNonce: {
          threadId: identity.threadId,
          clientNonce: `background-helper:${first.runId}`,
        },
      },
    });
    expect(card.blocks).toMatchObject([
      { kind: "subagent", agentId: first.runId, status: "running" },
    ]);
    const secondHelper = await runAsTenant(tenant, () =>
      createBackgroundHelper(prisma, {
        ...input,
        callId: "call-3",
        task: "Research a topic",
      }),
    );
    await runAsTenant(tenant, () =>
      createThreadMessage(prisma, {
        threadId: secondHelper.threadId,
        runId: secondHelper.runId,
        botId: identity.botId,
        role: "bot",
        blocks: [{ kind: "text", text: "Here is the result." }],
      }),
    );
    await system.run.update({ where: { id: secondHelper.runId }, data: { status: "completed" } });
    const delivered = await Promise.all([
      runAsTenant(tenant, () =>
        returnBackgroundHelperOutcome(prisma, {
          spaceId: identity.spaceId,
          runId: secondHelper.runId,
        }),
      ),
      runAsTenant(tenant, () =>
        returnBackgroundHelperOutcome(prisma, {
          spaceId: identity.spaceId,
          runId: secondHelper.runId,
        }),
      ),
    ]);
    expect(delivered.filter(Boolean)).toHaveLength(1);
    const resultCard = await system.message.findUniqueOrThrow({
      where: {
        threadId_clientNonce: {
          threadId: identity.threadId,
          clientNonce: `background-helper:${secondHelper.runId}`,
        },
      },
    });
    expect(resultCard.blocks).toMatchObject([
      { status: "completed", result: "Here is the result." },
    ]);
    expect(
      await system.steeringMessage.findMany({ where: { messageId: resultCard.id } }),
    ).toMatchObject([{ runId: parentRunId, originTrigger: "helper_result" }]);
    const stoppedHelper = await runAsTenant(tenant, () =>
      createBackgroundHelper(prisma, {
        ...input,
        callId: "call-4",
      }),
    );
    await system.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.run_reader_version', '3', true)`;
      await tx.run.update({
        where: { id: stoppedHelper.runId },
        data: { status: "running", leaseOwner: "helper-worker", leaseFence: 2 },
      });
    });
    const progressInput = {
      spaceId: identity.spaceId,
      runId: stoppedHelper.runId,
      lease: { owner: "helper-worker", fence: 2 },
      progress: "Searching the web",
    };
    expect(
      await runAsTenant(tenant, () => updateBackgroundHelperProgress(prisma, progressInput)),
    ).not.toBeNull();
    expect(
      await runAsTenant(tenant, () =>
        updateBackgroundHelperProgress(prisma, {
          ...progressInput,
          lease: { owner: "stale", fence: 1 },
          progress: "Stale",
        }),
      ),
    ).toBeNull();
    const stopped = await runAsTenant(tenant, () =>
      cancelBackgroundHelper(prisma, {
        spaceId: identity.spaceId,
        parentThreadId: identity.threadId,
        runId: stoppedHelper.runId,
      }),
    );
    expect(stopped).toEqual({ found: true, cancelled: true });
    await runAsTenant(tenant, () =>
      returnBackgroundHelperOutcome(prisma, {
        spaceId: identity.spaceId,
        runId: stoppedHelper.runId,
      }),
    );
    const stoppedCard = await system.message.findUniqueOrThrow({
      where: {
        threadId_clientNonce: {
          threadId: identity.threadId,
          clientNonce: `background-helper:${stoppedHelper.runId}`,
        },
      },
    });
    expect(stoppedCard.blocks).toMatchObject([
      { status: "failed", stopped: true, result: "Stopped." },
    ]);
    const cardData = (stoppedCard.blocks as Array<Record<string, unknown>>)[0]!;
    const oldCard = { ...cardData };
    delete oldCard.background;
    delete oldCard.stopped;
    expect(MessageBlock.parse(oldCard)).toMatchObject({ status: "failed", result: "Stopped." });
    expect(
      await runAsTenant(tenant, () => updateBackgroundHelperProgress(prisma, progressInput)),
    ).toBeNull();
    expect((await system.run.findUniqueOrThrow({ where: { id: parentRunId } })).status).toBe(
      "running",
    );
    expect(
      await system.event.count({ where: { threadId: identity.threadId, type: "run.cancelled" } }),
    ).toBe(0);
    const agedHelper = await runAsTenant(tenant, () =>
      createBackgroundHelper(prisma, {
        ...input,
        callId: "call-aged",
      }),
    );
    const agedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await system.run.update({ where: { id: agedHelper.runId }, data: { updatedAt: agedAt } });
    expect(
      await runAsTenant(tenant, () =>
        expireStuckBackgroundHelper(prisma, {
          spaceId: identity.spaceId,
          parentThreadId: identity.threadId,
          runId: agedHelper.runId,
          status: "queued",
          updatedAt: agedAt,
          now: new Date(),
        }),
      ),
    ).toBe(true);
    await runAsTenant(tenant, () =>
      returnBackgroundHelperOutcome(prisma, {
        spaceId: identity.spaceId,
        runId: agedHelper.runId,
      }),
    );
    const agedCard = await system.message.findUniqueOrThrow({
      where: {
        threadId_clientNonce: {
          threadId: identity.threadId,
          clientNonce: `background-helper:${agedHelper.runId}`,
        },
      },
    });
    expect(agedCard.blocks).toMatchObject([
      { status: "failed", result: "Background helper could not start in time." },
    ]);
    expect((agedCard.blocks as Array<Record<string, unknown>>)[0]?.stopped).toBeUndefined();
    expect(
      await system.steeringMessage.findMany({ where: { messageId: agedCard.id } }),
    ).toMatchObject([{ originTrigger: "helper_result" }]);
    expect(
      await system.event.count({ where: { threadId: agedHelper.threadId, type: "run.cancelled" } }),
    ).toBe(0);
    const steering = await runAsTenant(tenant, () =>
      claimSteering(prisma, {
        threadId: identity.threadId,
        botId: identity.botId,
        runId: parentRunId,
        leaseOwner: "worker",
        leaseFence: 1,
        seenIds: [],
      }),
    );
    expect(steering.find((item) => item.messageId === resultCard.id)).toMatchObject({
      origin: "helper",
      text: "Here is the result.",
    });
    await expect(
      runAsTenant(tenant, () =>
        createBackgroundHelper(prisma, { ...input, callId: "after-outside" }),
      ),
    ).rejects.toThrow("source is no longer trusted");
    expect(await runAsTenant(tenant, () => findBackgroundHelper(prisma, input))).toMatchObject({
      runId: first.runId,
    });
    const cleared = await runAsTenant(tenant, () =>
      clearThread(prisma, {
        spaceId: identity.spaceId,
        threadId: identity.threadId,
        botId: identity.botId,
      }),
    );
    expect(cleared.cancelledRunIds).toContain(first.runId);
    expect(await system.thread.findUnique({ where: { id: first.threadId } })).toBeNull();
    expect(await system.run.findUnique({ where: { id: first.runId } })).toBeNull();
    const oldApiTask = await system.task.create({
      data: {
        spaceId: identity.spaceId,
        botId: identity.botId,
        threadId: identity.threadId,
        userId: identity.userId,
        prompt: "Another task",
        status: "running",
      },
    });
    const oldApiParent = await system.run.create({
      data: {
        spaceId: identity.spaceId,
        botId: identity.botId,
        threadId: identity.threadId,
        userId: identity.userId,
        taskId: oldApiTask.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker",
        leaseFence: 1,
      },
    });
    const oldApiChild = await runAsTenant(tenant, () =>
      createBackgroundHelper(prisma, {
        ...input,
        parentRunId: oldApiParent.id,
        callId: "old-api-clear",
      }),
    );
    const space = await system.space.findUniqueOrThrow({ where: { id: identity.spaceId } });
    await system.modelCreditAccount.upsert({
      where: { organizationId: space.organizationId },
      create: { organizationId: space.organizationId, balanceMicros: 10_000n },
      update: {},
    });
    await system.modelCreditEntry.create({
      data: {
        organizationId: space.organizationId,
        source: "late-helper-reservation",
        callId: "late-helper-usage",
        amountMicros: -1_000n,
        pending: true,
        userId: identity.userId,
        spaceId: identity.spaceId,
        runId: oldApiChild.runId,
        provider: "fixture",
        model: "fixture",
        reconciliationState: "pending",
      },
    });
    await expect(
      runAsTenant(tenant, () =>
        prisma.$transaction(async (tx) => {
          await tx.thread.update({
            where: { id: identity.threadId },
            data: { historyCompactionGeneration: { increment: 1 } },
          });
          throw new Error("rollback clear");
        }),
      ),
    ).rejects.toThrow("rollback clear");
    expect(await system.thread.findUnique({ where: { id: oldApiChild.threadId } })).not.toBeNull();
    await system.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.run_reader_version', '3', true)`;
      await tx.run.update({
        where: { id: oldApiChild.runId },
        data: { status: "running", leaseOwner: "helper-worker", leaseFence: 2 },
      });
    });
    const finishing = await runAsTenant(tenant, () =>
      createBackgroundHelper(prisma, {
        ...input,
        parentRunId: oldApiParent.id,
        callId: "old-api-finish",
      }),
    );
    const foreignMessage = await runAsTenant(tenant, () =>
      createThreadMessage(prisma, {
        threadId: identity.threadId,
        role: "user",
        blocks: [{ kind: "text", text: "From another member" }],
      }),
    );
    await system.steeringMessage.create({
      data: {
        messageId: foreignMessage.id,
        botId: identity.botId,
        userId: "other-member",
        runId: oldApiParent.id,
        claimedAt: new Date(),
      },
    });
    await expect(
      runAsTenant(tenant, () =>
        createBackgroundHelper(prisma, {
          ...input,
          parentRunId: oldApiParent.id,
          callId: "foreign-member",
        }),
      ),
    ).rejects.toThrow("source is no longer trusted");
    await runAsTenant(tenant, () =>
      createThreadMessage(prisma, {
        threadId: finishing.threadId,
        runId: finishing.runId,
        botId: identity.botId,
        role: "bot",
        blocks: [{ kind: "text", text: "Finished while clearing." }],
      }),
    );
    await system.run.update({ where: { id: finishing.runId }, data: { status: "completed" } });
    // An old API resets this field without knowing that helper threads exist.
    await Promise.all([
      runAsTenant(tenant, () =>
        prisma.$transaction(async (tx) => {
          await tx.thread.update({ where: { id: identity.threadId }, data: { unread: false } });
          await tx.message.deleteMany({ where: { threadId: identity.threadId } });
          await tx.thread.update({
            where: { id: identity.threadId },
            data: { historyCompactionGeneration: { increment: 1 } },
          });
        }),
      ),
      runAsTenant(tenant, () =>
        updateBackgroundHelperProgress(prisma, {
          spaceId: identity.spaceId,
          runId: oldApiChild.runId,
          lease: { owner: "helper-worker", fence: 2 },
          progress: "Working",
        }),
      ),
      runAsTenant(tenant, () =>
        returnBackgroundHelperOutcome(prisma, {
          spaceId: identity.spaceId,
          runId: finishing.runId,
        }),
      ),
    ]);
    expect(await system.thread.findUnique({ where: { id: oldApiChild.threadId } })).toBeNull();
    expect(await system.run.findUnique({ where: { id: oldApiChild.runId } })).toBeNull();
    expect(await system.thread.findUnique({ where: { id: finishing.threadId } })).toBeNull();
    expect(
      await system.message.findUnique({
        where: {
          threadId_clientNonce: {
            threadId: identity.threadId,
            clientNonce: `background-helper:${finishing.runId}`,
          },
        },
      }),
    ).toBeNull();
    // A provider can report usage after the in-flight run was deleted.
    await runAsTenant(tenant, () =>
      recordUsage(
        prisma,
        {
          type: "usage",
          provider: "fixture",
          model: "fixture",
          callId: "late-helper-usage",
          inputTokens: 8,
          outputTokens: 2,
          costUsd: 0.001,
          costSource: "provider-reported",
        },
        {
          spaceId: identity.spaceId,
          userId: identity.userId,
          botId: identity.botId,
          runId: oldApiChild.runId,
        },
      ),
    );
    expect(
      await system.usageRecord.findUnique({ where: { callId: "late-helper-usage" } }),
    ).toMatchObject({ runId: oldApiChild.runId, inputTokens: 8 });
    expect(
      await system.modelCreditEntry.findUnique({ where: { callId: "late-helper-usage" } }),
    ).toMatchObject({
      runId: oldApiChild.runId,
      pending: false,
      amountMicros: -1_000n,
      reconciliationState: "complete",
    });
  });
});
