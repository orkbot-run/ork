// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited bot delivery remains Apache-2.0; Space work admission guards are Ork additions.
// Ork changes consolidate database error matching through the shared database predicates.

import { runContinueJob } from "@orkbot/adapter-kit";
import type { BotMessageIntent, MessageBlock } from "@orkbot/contracts";
import {
  BOT_MESSAGE_MAX_LENGTH,
  botMessageContext,
  botMessageHopExhausted,
  buildBotMessageWakePrompt,
  clampBotMessage,
  nextBotMessageHop,
  resolveBotAddress,
} from "@orkbot/core";
import type { PrismaClient } from "@orkbot/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  isUniqueViolation,
  lockSpaceForWork,
  RUN_READER_VERSION,
  RunHistoryWriteError,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@orkbot/db";
import { getLogger } from "@orkbot/logging";
import type { BotFileSource } from "./bot-message-files.js";
import { BotFileTransferError, botFilePaths, prepareBotFiles } from "./bot-message-files.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { runLeaseFor } from "./run-messages.js";

/**
 * The hop the current run sits at, read back from the message that woke this
 * bot. A run a person started carries no bot message, so it starts at 0.
 */
export async function currentBotMessageHop(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
): Promise<number> {
  if (!sourceMessageId) return 0;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true },
  });
  const blocks = Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [];
  return botMessageContext(blocks)?.hop ?? 0;
}

export async function loadBotMessageContext(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
) {
  if (!sourceMessageId) return undefined;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true, replyTo: { select: { blocks: true } } },
  });
  const context = botMessageContext(
    Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [],
  );
  if (!context) return undefined;
  const replyBlocks = Array.isArray(source?.replyTo?.blocks)
    ? (source.replyTo.blocks as MessageBlock[])
    : [];
  const repliesToRequest =
    (context.intent === "result" || context.intent === "status" || context.intent === "fyi") &&
    replyBlocks.some(
      (block) =>
        block.kind === "bot_message_sent" &&
        block.toBotId === context.fromBotId &&
        (block.intent === undefined || block.intent === "request" || block.intent === "question"),
    );
  return { ...context, repliesToRequest };
}

export async function messageBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "runLease"> &
    Partial<Pick<ExecutorDeps, "sandbox" | "artifacts" | "maxUploadSizeBytes">>,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  sender: { id: string; name: string },
  input: {
    bot_id?: string;
    confirm_name?: string;
    message: string;
    intent?: BotMessageIntent;
    deliveryKey?: string;
    files?: string[];
  },
  options?: { allowTerminalSource?: boolean; forceUnread?: boolean; fileSource?: BotFileSource },
) {
  let filePaths: string[];
  try {
    filePaths = botFilePaths(input.files);
  } catch (error) {
    return { ok: false as const, error: (error as BotFileTransferError).message };
  }
  const message = String(input.message ?? "").trim();
  if (!message) return { ok: false as const, error: "message is required" };
  if (message.length > BOT_MESSAGE_MAX_LENGTH) {
    return {
      ok: false as const,
      error: `message exceeds the ${BOT_MESSAGE_MAX_LENGTH} character limit; save longer content to a file and pass its path using files`,
    };
  }

  const sourceContext = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  const intent = input.intent ?? "request";
  const hop = nextBotMessageHop(sourceContext?.hop);

  const candidates = await deps.prisma.bot.findMany({
    where: { spaceId: run.spaceId, userId: run.userId, archivedAt: null },
    select: { id: true, name: true, computerId: true, thread: { select: { id: true } } },
  });
  const target = resolveBotAddress(candidates, {
    botId: input.bot_id,
    name: input.confirm_name,
  });
  if (!target) return { ok: false as const, error: "no bot found with that id or name" };
  if (target.id === sender.id) return { ok: false as const, error: "a bot cannot message itself" };
  if (!target.thread)
    return { ok: false as const, error: `${target.name} has no chat to deliver to` };
  const returnsToSender =
    options?.allowTerminalSource === true &&
    (intent === "result" || intent === "status") &&
    (sourceContext?.intent === undefined ||
      sourceContext.intent === "request" ||
      sourceContext.intent === "question") &&
    sourceContext?.fromBotId === target.id;
  if (botMessageHopExhausted(hop) && !returnsToSender) {
    return {
      ok: false as const,
      error:
        "bot-to-bot message limit reached for this chain; report back to the user instead of messaging another bot",
    };
  }

  const targetThreadId = target.thread.id;

  // A tool call can be re-executed after a lease expiry, so a delivery has to be
  // replayable: without this the recipient is messaged twice and woken twice.
  const deliveryKey = input.deliveryKey ? `bot-message:${input.deliveryKey}` : undefined;
  let prepared: Awaited<ReturnType<typeof prepareBotFiles>>;
  if (filePaths.length) {
    try {
      const prior =
        deliveryKey &&
        (await deps.prisma.message.findFirst({
          where: { clientNonce: deliveryKey, thread: { spaceId: run.spaceId, userId: run.userId } },
          select: { threadId: true },
        }));
      if (prior && prior.threadId !== targetThreadId)
        return { ok: false as const, error: "File delivery belongs to a different recipient" };
      if (!prior)
        prepared = await prepareBotFiles(
          deps,
          run,
          { botId: target.id, threadId: targetThreadId, computerId: target.computerId ?? null },
          filePaths,
          deliveryKey,
          options?.fileSource,
        );
    } catch (error) {
      if (error instanceof BotFileTransferError)
        return { ok: false as const, error: error.message };
      throw error;
    }
  }
  const replayed = () =>
    ({
      ok: true as const,
      botId: target.id,
      name: target.name,
      delivered: message,
      replayed: true as const,
      note: `Already sent to ${target.name} in this turn; it was not sent again.`,
    }) as const;

  const wakePrompt = buildBotMessageWakePrompt({ from: sender, text: message, intent });
  const outboundBlock: MessageBlock = {
    kind: "bot_message_sent",
    toBotId: target.id,
    toBotName: target.name,
    text: message,
    intent,
  };

  let committed:
    | {
        ok: true;
        runId: string;
        targetEventSeq: number;
        senderEventSeq: number;
      }
    | {
        ok: false;
        error: string;
      }
    | {
        ok: true;
        replayed: true;
      };
  let transactionKnownSettled = false;
  try {
    committed = await withTransactionRetry(() =>
      deps.prisma
        .$transaction(async (tx) => {
          await lockSpaceForWork(tx, run.spaceId);
          for (const threadId of [run.threadId, targetThreadId].sort()) {
            await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
          }
          // Claim the delivery key inside the transaction so a concurrent retry
          // either sees the winner or loses on the unique (threadId, clientNonce).
          if (deliveryKey) {
            const already = await tx.message.findUnique({
              where: {
                threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey },
              },
              select: { id: true },
            });
            if (already) return { ok: true as const, replayed: true as const };
          }

          const senderStillRunning = await tx.run.findFirst({
            where: {
              id: run.id,
              spaceId: run.spaceId,
              threadId: run.threadId,
              botId: run.botId,
              userId: run.userId,
              status: options?.allowTerminalSource
                ? { in: ["completed", "failed", "cancelled"] }
                : "running",
            },
            select: { id: true },
          });
          if (!senderStillRunning)
            return { ok: false as const, error: "source run is no longer active" };

          // Re-read the target inside the transaction: it can be archived between
          // resolving it above and committing here.
          const stillAddressable = await tx.bot.findFirst({
            where: {
              id: target.id,
              spaceId: run.spaceId,
              userId: run.userId,
              archivedAt: null,
            },
            select: { id: true },
          });
          if (!stillAddressable)
            return { ok: false as const, error: `${target.name} is no longer available` };

          const fileBlocks = (await prepared?.commit(tx)) ?? [];

          // Echo into the sender's chat in the same transaction so a failed notify
          // cannot leave one side delivered and the other blank.
          const outbound = await createThreadMessageInTransaction(tx, {
            threadId: run.threadId,
            role: "bot",
            blocks: [outboundBlock, ...fileBlocks],
            botId: run.botId,
            runId: run.id,
            markUnread: options?.forceUnread === true,
            allowCancelledRun: options?.allowTerminalSource === true,
            lease: runLeaseFor(deps, run.id),
          });
          const inboundBlock: MessageBlock = {
            kind: "bot_message_received",
            fromBotId: sender.id,
            fromBotName: sender.name,
            text: message,
            hop,
            intent,
            returnToMessageId: outbound.id,
            ...(prepared?.workspaceFiles ? { workspaceFiles: prepared.workspaceFiles } : {}),
          };
          const inbound = await createThreadMessageInTransaction(tx, {
            threadId: targetThreadId,
            role: "user",
            blocks: [inboundBlock, ...fileBlocks],
            replyToMessageId:
              sourceContext?.fromBotId === target.id && intent !== "fyi"
                ? sourceContext.returnToMessageId
                : undefined,
            clientNonce: deliveryKey,
            markUnread: options?.forceUnread === true,
          });
          const task = await tx.task.create({
            data: {
              spaceId: run.spaceId,
              botId: target.id,
              threadId: targetThreadId,
              userId: run.userId,
              prompt: wakePrompt,
              status: "queued",
            },
          });
          const nextRun = await tx.run.create({
            data: {
              spaceId: run.spaceId,
              botId: target.id,
              threadId: targetThreadId,
              taskId: task.id,
              userId: run.userId,
              status: "queued",
              trigger: "bot_message",
              ...(filePaths.length ? { requiredReaderVersion: RUN_READER_VERSION } : {}),
              sourceMessageId: inbound.id,
            },
            select: { id: true },
          });
          await tx.message.update({ where: { id: inbound.id }, data: { runId: nextRun.id } });
          const inboundEvent = await appendEventInTransaction(tx, {
            spaceId: run.spaceId,
            threadId: targetThreadId,
            botId: target.id,
            type: "thread.message.created",
            runId: nextRun.id,
            payload: { messageId: inbound.id, role: "user", blocks: [inboundBlock, ...fileBlocks] },
          });
          const outboundEvent = await appendEventInTransaction(tx, {
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            type: "thread.message.created",
            runId: run.id,
            allowCancelledRun: options?.allowTerminalSource === true,
            lease: runLeaseFor(deps, run.id),
            payload: {
              messageId: outbound.id,
              role: "bot",
              blocks: [outboundBlock, ...fileBlocks],
            },
          });
          return {
            ok: true as const,
            runId: nextRun.id,
            targetEventSeq: inboundEvent.seq,
            senderEventSeq: outboundEvent.seq,
          };
        }, THREAD_LOCK_TRANSACTION_OPTIONS)
        .then((result) => {
          transactionKnownSettled = true;
          return result;
        }),
    );
  } catch (error) {
    if (error instanceof RunHistoryWriteError) transactionKnownSettled = true;
    if (error instanceof BotFileTransferError) {
      transactionKnownSettled = true;
      return { ok: false as const, error: error.message };
    }
    // Two concurrent retries can both miss the in-transaction lookup; the
    // loser hits the unique key. Treat that as a successful replay.
    if (deliveryKey && isUniqueViolation(error)) {
      const winner = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
        select: { id: true },
      });
      if (winner) return replayed();
    }
    throw error;
  } finally {
    await prepared?.cleanup(transactionKnownSettled);
  }
  if ("replayed" in committed) return replayed();
  if (!committed.ok) return committed;

  await deps.events.notify(targetThreadId, committed.targetEventSeq).catch((error) => {
    getLogger().error("bot message realtime notification", error);
  });
  await deps.events.notify(run.threadId, committed.senderEventSeq).catch((error) => {
    getLogger().error("bot message sender echo notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    // The queued run is durable; the job reconciler repairs a missed wake.
    getLogger().error("bot message enqueue", error);
  });
  return {
    ok: true as const,
    botId: target.id,
    name: target.name,
    delivered: message,
    note: `Sent to ${target.name}. Delivery is async; a reply wakes you later as a new message. Continue independent work; send another update later only if it adds something new.`,
  };
}

/** Return a delegated run's terminal outcome unless it already sent one explicitly. */
export async function returnBotMessageOutcome(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  sender: { id: string; name: string },
  text: string,
  intent: "result" | "status" = "result",
  options?: { forceUnread?: boolean },
) {
  const source = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  if (!source) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    // Handled: nothing to deliver. Return true so callers do not release a reservation.
    return true;
  }
  const sourceIntent = source.intent ?? "request";
  if (sourceIntent !== "request" && sourceIntent !== "question") {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  const sent = await deps.prisma.message.findMany({
    where: { threadId: run.threadId, runId: run.id },
    select: { blocks: true },
  });
  // Only an explicit result counts as a terminal outcome. Interim message_bot
  // status updates must not suppress the automatic final return.
  const alreadyReturned = sent.some((message) =>
    (Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : []).some(
      (block) =>
        block.kind === "bot_message_sent" &&
        block.toBotId === source.fromBotId &&
        block.intent === "result",
    ),
  );
  if (alreadyReturned) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  // messageBot reaches only active bots of this space and user, so an archived or deleted
  // requester can never take the outcome. Handled: nothing is left to deliver.
  const requester = await deps.prisma.bot.findFirst({
    where: { id: source.fromBotId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
    select: { id: true },
  });
  if (!requester) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  const outcome = await messageBot(
    deps,
    run,
    sender,
    {
      bot_id: source.fromBotId,
      message: clampBotMessage(text),
      intent,
      // One key per run so status vs result (executor vs reconciler) cannot double-deliver.
      deliveryKey: `auto-outcome:${run.id}`,
    },
    {
      allowTerminalSource: true,
      forceUnread: options?.forceUnread,
    },
  );
  if (outcome.ok) await markBotOutcomeReturned(deps.prisma, run.id);
  return outcome.ok;
}

async function markBotOutcomeReturned(prisma: PrismaClient, runId: string) {
  await prisma.run.updateMany({
    where: {
      id: runId,
      status: { in: ["completed", "failed", "cancelled"] },
      botOutcomeReturnedAt: null,
    },
    data: { botOutcomeReturnedAt: new Date() },
  });
}
