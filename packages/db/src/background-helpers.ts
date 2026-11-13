// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { MessageBlock as MessageBlockSchema } from "@orkbot/contracts";
import { isOwnerStartedRun, QUEUE_HOLDING_RUN_STATUSES } from "@orkbot/core";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction, createPendingSteeringRun } from "./events.js";
import type { RunLease } from "./messages.js";
import { assertRunCanWriteHistory, createThreadMessageInTransaction } from "./messages.js";
import { BACKGROUND_HELPER_READER_VERSION } from "./run-reader-version.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "./transaction-options.js";

const EXPIRED_HELPER_ERROR = "Background helper could not start in time.";

/** A stale or stopped helper cannot replace the terminal card with progress. */
export async function updateBackgroundHelperProgress(
  prisma: PrismaClient,
  input: { spaceId: string; runId: string; lease: RunLease; progress: string },
) {
  return prisma.$transaction(async (tx) => {
    const candidate = await tx.run.findFirst({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        trigger: "tickets",
        thread: { parentThreadId: { not: null } },
      },
      select: { thread: { select: { parentThreadId: true } } },
    });
    const parentThreadId = candidate?.thread?.parentThreadId;
    if (!parentThreadId) return null;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM threads WHERE id = ${parentThreadId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    if (!rows.length) return null;
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${input.runId} FOR SHARE`;
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        status: "running",
        leaseOwner: input.lease.owner,
        leaseFence: input.lease.fence,
        thread: { parentThreadId },
      },
      select: { botId: true },
    });
    if (!run) return null;
    const card = await tx.message.findUnique({
      where: {
        threadId_clientNonce: {
          threadId: parentThreadId,
          clientNonce: `background-helper:${input.runId}`,
        },
      },
    });
    if (!card) return null;
    const blocks = MessageBlockSchema.array().parse(card.blocks);
    const block = blocks.find((item) => item.kind === "subagent" && item.agentId === input.runId);
    if (!block || block.kind !== "subagent" || block.status !== "running") return null;
    if (block.progress === input.progress) return null;
    const next = blocks.map((item) =>
      item === block ? { ...block, progress: input.progress.slice(0, 200) } : item,
    );
    await tx.message.update({
      where: { id: card.id },
      data: { blocks: next as Prisma.InputJsonValue },
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: parentThreadId,
      botId: run.botId,
      type: "thread.message.updated",
      payload: { messageId: card.id, blocks: next },
    });
    return { threadId: parentThreadId, eventSeq: event.seq };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}

/** Stop only a helper in the already-authorized parent thread. */
export async function cancelBackgroundHelper(
  prisma: PrismaClient,
  input: { spaceId: string; parentThreadId: string; runId: string },
): Promise<{ found: boolean; cancelled: boolean }> {
  return prisma.$transaction(async (tx) => {
    const parent = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM threads WHERE id = ${input.parentThreadId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    if (!parent.length) return { found: false, cancelled: false };
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        trigger: "tickets",
        thread: { parentThreadId: input.parentThreadId },
      },
      select: { id: true, taskId: true, spaceId: true, userId: true },
    });
    if (!run) return { found: false, cancelled: false };
    const cancelled = await cancelRunsInTransaction(tx, [run], new Date());
    if (cancelled.length) await tx.run.update({ where: { id: run.id }, data: { error: null } });
    return { found: true, cancelled: cancelled.length > 0 };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}

/** Expire an aged helper without publishing a user-facing event in its private thread. */
export async function expireStuckBackgroundHelper(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    parentThreadId: string;
    runId: string;
    status: string;
    updatedAt: Date;
    now: Date;
  },
) {
  return prisma.$transaction(async (tx) => {
    const parent = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM threads WHERE id = ${input.parentThreadId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    if (!parent.length) return false;
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${input.runId} FOR UPDATE`;
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        trigger: "tickets",
        status: input.status,
        updatedAt: input.updatedAt,
        thread: { parentThreadId: input.parentThreadId },
      },
      select: { id: true, taskId: true, userId: true, spaceId: true },
    });
    if (!run) return false;
    const cancelled = await cancelRunsInTransaction(tx, [run], input.now);
    if (!cancelled.length) return false;
    await tx.run.update({ where: { id: run.id }, data: { error: EXPIRED_HELPER_ERROR } });
    return true;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}

export interface CreateBackgroundHelperInput {
  spaceId: string;
  parentThreadId: string;
  parentRunId: string;
  parentLease: RunLease;
  callId: string;
  name: string;
  task: string;
}

/** Recover a previously admitted helper without creating new work. */
export async function findBackgroundHelper(
  prisma: PrismaClient,
  input: Pick<
    CreateBackgroundHelperInput,
    "spaceId" | "parentThreadId" | "parentRunId" | "parentLease" | "callId"
  >,
) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM threads WHERE id = ${input.parentThreadId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    if (!rows.length) return null;
    await assertRunCanWriteHistory(tx, input.parentRunId, { lease: input.parentLease });
    const parent = await tx.run.findFirst({
      where: {
        id: input.parentRunId,
        threadId: input.parentThreadId,
        spaceId: input.spaceId,
        status: "running",
        leaseOwner: input.parentLease.owner,
        leaseFence: input.parentLease.fence,
      },
      select: { id: true },
    });
    if (!parent) return null;
    const thread = await tx.thread.findUnique({
      where: {
        parentRunId_helperCallId: { parentRunId: input.parentRunId, helperCallId: input.callId },
      },
      select: { id: true, parentThreadId: true, runs: { select: { id: true }, take: 1 } },
    });
    const runId = thread?.runs[0]?.id;
    return thread?.parentThreadId === input.parentThreadId && runId
      ? { threadId: thread.id, runId }
      : null;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}

/** Commit a terminal helper result and its wake-up together; repeated delivery is harmless. */
export async function returnBackgroundHelperOutcome(
  prisma: PrismaClient,
  input: { spaceId: string; runId: string },
) {
  return prisma.$transaction(async (tx) => {
    const candidate = await tx.run.findFirst({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        trigger: "tickets",
        thread: { parentThreadId: { not: null } },
      },
      select: { thread: { select: { parentThreadId: true } } },
    });
    const parentThreadId = candidate?.thread.parentThreadId;
    if (!parentThreadId) return null;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM threads WHERE id = ${parentThreadId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    if (!rows.length) return null;
    // The parent lock serializes completion, stop, and clearing the conversation.
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${input.runId} FOR UPDATE`;
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        trigger: "tickets",
        status: { in: ["completed", "failed", "cancelled"] },
        botOutcomeReturnedAt: null,
        thread: { parentThreadId },
      },
      select: { id: true, botId: true, userId: true, threadId: true, status: true, error: true },
    });
    if (!run) return null;
    const card = await tx.message.findUnique({
      where: {
        threadId_clientNonce: {
          threadId: parentThreadId,
          clientNonce: `background-helper:${run.id}`,
        },
      },
    });
    if (!card) throw new Error("Background helper card is unavailable");
    const parsed = MessageBlockSchema.array().parse(card.blocks);
    const block = parsed.find((item) => item.kind === "subagent" && item.agentId === run.id);
    if (!block || block.kind !== "subagent" || block.status !== "running") {
      throw new Error("Background helper card is not awaiting a result");
    }
    const final =
      run.status === "completed"
        ? await tx.message.findFirst({
            where: { runId: run.id, threadId: run.threadId, role: "bot" },
            orderBy: { seq: "desc" },
            select: { blocks: true },
          })
        : null;
    const expired = run.status === "cancelled" && run.error === EXPIRED_HELPER_ERROR;
    const result =
      run.status === "completed"
        ? MessageBlockSchema.array()
            .parse(final?.blocks ?? [])
            .filter((item) => item.kind === "text")
            .map((item) => item.text)
            .join("\n")
            .trim()
            .slice(0, 12_000) || "Helper completed without a written result."
        : expired
          ? EXPIRED_HELPER_ERROR
          : run.status === "cancelled"
            ? "Stopped."
            : "Helper failed.";
    const blocks = parsed.map((item) =>
      item === block
        ? {
            ...block,
            status: run.status === "completed" ? ("completed" as const) : ("failed" as const),
            ...(run.status === "cancelled" && !expired ? { stopped: true } : {}),
            result,
          }
        : item,
    );
    await tx.message.update({
      where: { id: card.id },
      data: { blocks: blocks as Prisma.InputJsonValue },
    });
    await tx.run.update({ where: { id: run.id }, data: { botOutcomeReturnedAt: new Date() } });
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: parentThreadId,
      botId: run.botId,
      type: "thread.message.updated",
      payload: { messageId: card.id, blocks },
    });
    let wakeRunId: string | null = null;
    if (run.status !== "cancelled" || expired) {
      const active = await tx.run.findFirst({
        where: {
          threadId: parentThreadId,
          botId: run.botId,
          status: { in: [...QUEUE_HOLDING_RUN_STATUSES] },
        },
        select: { id: true, trigger: true },
      });
      // A helper result is data, never an instruction from the human owner.
      const steerable = active && ["user", "follow_up"].includes(active.trigger) ? active : null;
      await tx.steeringMessage.create({
        data: {
          messageId: card.id,
          botId: run.botId,
          userId: run.userId,
          runId: steerable?.id ?? null,
          originTrigger: "helper_result",
        },
      });
      if (!active)
        wakeRunId = await createPendingSteeringRun(tx, {
          spaceId: input.spaceId,
          threadId: parentThreadId,
          botId: run.botId,
        });
    }
    return { threadId: parentThreadId, eventSeq: event.seq, wakeRunId };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}

/** Persist one helper per tool call. The caller must wake the worker after committing. */
export async function createBackgroundHelper(
  prisma: PrismaClient,
  input: CreateBackgroundHelperInput,
) {
  const name = input.name.trim();
  const task = input.task.trim();
  if (!name || name.length > 80 || !task || !input.callId.trim()) {
    throw new Error("Invalid background helper request");
  }
  return prisma.$transaction(async (tx) => {
    // The same order is used by chat clearing: parent thread, then parent run.
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM threads WHERE id = ${input.parentThreadId}
        AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    if (!rows.length) throw new Error("Parent thread is unavailable");
    await assertRunCanWriteHistory(tx, input.parentRunId, { lease: input.parentLease });
    const parent = await tx.run.findFirst({
      where: {
        id: input.parentRunId,
        threadId: input.parentThreadId,
        spaceId: input.spaceId,
        status: "running",
        leaseOwner: input.parentLease.owner,
        leaseFence: input.parentLease.fence,
      },
      select: {
        botId: true,
        userId: true,
        trigger: true,
        bot: { select: { userId: true } },
        sourceMessage: { select: { role: true, blocks: true } },
      },
    });
    if (!parent) throw new Error("Parent run is unavailable");
    const sourceBlocks = MessageBlockSchema.array().safeParse(parent.sourceMessage?.blocks ?? []);
    if (
      parent.userId !== parent.bot.userId ||
      !isOwnerStartedRun(parent.trigger, parent.sourceMessage?.role === "user") ||
      !sourceBlocks.success ||
      sourceBlocks.data.some((block) => block.kind === "channel_message")
    ) {
      throw new Error("Background helper source is not the bot owner's app conversation");
    }
    const outside = await tx.steeringMessage.findFirst({
      where: {
        runId: input.parentRunId,
        claimedAt: { not: null },
        OR: [
          { userId: { not: parent.userId } },
          { originTrigger: { not: null } },
          { message: { blocks: { array_contains: [{ kind: "channel_message" }] } } },
        ],
      },
      select: { id: true },
    });
    if (outside) throw new Error("Background helper source is no longer trusted");
    const existing = await tx.thread.findUnique({
      where: {
        parentRunId_helperCallId: { parentRunId: input.parentRunId, helperCallId: input.callId },
      },
      select: { id: true, runs: { select: { id: true }, take: 1 } },
    });
    if (existing) {
      const runId = existing.runs[0]?.id;
      if (!runId) throw new Error("Background helper has no run");
      return { threadId: existing.id, runId, created: false, eventSeq: null };
    }
    const thread = await tx.thread.create({
      data: {
        spaceId: input.spaceId,
        userId: parent.userId,
        parentThreadId: input.parentThreadId,
        parentRunId: input.parentRunId,
        helperCallId: input.callId,
      },
      select: { id: true },
    });
    const helperTask = await tx.task.create({
      data: {
        spaceId: input.spaceId,
        botId: parent.botId,
        threadId: thread.id,
        userId: parent.userId,
        prompt: task,
        status: "queued",
      },
      select: { id: true },
    });
    const run = await tx.run.create({
      data: {
        spaceId: input.spaceId,
        botId: parent.botId,
        threadId: thread.id,
        taskId: helperTask.id,
        userId: parent.userId,
        status: "queued",
        trigger: "tickets",
        clientNonce: `background-helper:${thread.id}`,
        requiredReaderVersion: BACKGROUND_HELPER_READER_VERSION,
      },
      select: { id: true },
    });
    const blocks = [
      {
        kind: "subagent" as const,
        agentId: run.id,
        name,
        task,
        status: "running" as const,
        background: true,
        progress: "Starting",
      },
    ];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: input.parentThreadId,
      role: "bot",
      botId: parent.botId,
      runId: input.parentRunId,
      lease: input.parentLease,
      clientNonce: `background-helper:${run.id}`,
      markUnread: false,
      blocks,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.parentThreadId,
      botId: parent.botId,
      runId: input.parentRunId,
      lease: input.parentLease,
      type: "thread.message.created",
      payload: { messageId: message.id, seq: message.seq, role: "bot", blocks },
    });
    return { threadId: thread.id, runId: run.id, created: true, eventSeq: event.seq };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}
