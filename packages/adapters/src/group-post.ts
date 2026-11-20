// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { MessageBlock } from "@orkbot/contracts";
import { BOT_MESSAGE_MAX_LENGTH } from "@orkbot/core";
import type { Prisma } from "@orkbot/db";
import {
  appendEventInTransaction,
  assertRunCanWriteHistory,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
  lockSpaceForWork,
  RunHistoryWriteError,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  touchGroupUpdatedAt,
} from "@orkbot/db";
import { getLogger } from "@orkbot/logging";
import type { BotFileSource } from "./bot-message-files.js";
import { BotFileTransferError, botFilePaths, prepareBotFiles } from "./bot-message-files.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { runLeaseFor } from "./run-messages.js";

type SourceRun = { id: string; spaceId: string; userId: string; botId: string; threadId: string };
const normalizeName = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

/** Publish a durable group message without admitting work for any group member. */
export async function postToGroup(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "runLease"> &
    Partial<Pick<ExecutorDeps, "sandbox" | "artifacts" | "maxUploadSizeBytes">>,
  run: SourceRun,
  input: { group: string; message: string; deliveryKey: string; files?: string[] },
  options?: { fileSource?: BotFileSource },
) {
  const text = input.message.trim();
  if (!text || text.length > BOT_MESSAGE_MAX_LENGTH)
    return { error: `message must contain 1 to ${BOT_MESSAGE_MAX_LENGTH} characters` } as const;
  if (!input.group.trim()) return { error: "group must contain a group ID or name" } as const;
  if (!input.deliveryKey.trim()) return { error: "deliveryKey is required" } as const;
  const nonce = `group-post:${run.id}:${input.deliveryKey}`;
  let paths: string[];
  try {
    paths = botFilePaths(input.files);
  } catch (error) {
    return { error: (error as BotFileTransferError).message } as const;
  }

  const groupsFor = (db: Pick<Prisma.TransactionClient, "chatGroup">) =>
    db.chatGroup.findMany({
      where: {
        spaceId: run.spaceId,
        userId: run.userId,
        archivedAt: null,
        members: { some: { botId: run.botId, bot: { archivedAt: null } } },
        thread: { isNot: null },
      },
      select: { id: true, name: true, thread: { select: { id: true } } },
    });
  const previousFor = (db: Pick<Prisma.TransactionClient, "message">) =>
    db.message.findFirst({
      where: {
        clientNonce: nonce,
        botId: run.botId,
        thread: { spaceId: run.spaceId, userId: run.userId },
      },
      select: { id: true, threadId: true, thread: { select: { groupId: true } } },
    });
  type Resolved = {
    group: { id: string; name: string; thread: { id: string } | null };
    previous: Awaited<ReturnType<typeof previousFor>>;
  };
  const resolve = async (
    db: Pick<Prisma.TransactionClient, "chatGroup" | "message">,
  ): Promise<Resolved | { error: string }> => {
    // A delivery key pins its first destination even if its name subsequently changes.
    const previous = await previousFor(db);
    const groups = await groupsFor(db);
    const matches = previous
      ? groups.filter((group) => group.id === previous.thread.groupId)
      : groups.filter((group) => group.id === input.group);
    if (!previous && !matches.length)
      matches.push(
        ...groups.filter((group) => normalizeName(group.name) === normalizeName(input.group)),
      );
    if (matches.length > 1) return { error: "group name is ambiguous; use its group ID" } as const;
    const group = matches[0];
    if (!group?.thread)
      return { error: "group is unavailable or the bot is not a member" } as const;
    if (group.thread.id === run.threadId)
      return { error: "reply normally to publish in the current group" } as const;
    return { group, previous };
  };

  let prepared: Awaited<ReturnType<typeof prepareBotFiles>>;
  let preparedGroupId: string | undefined;
  if (paths.length) {
    const target = await resolve(deps.prisma);
    if ("error" in target) return target;
    if (!target.previous) {
      const bot = await deps.prisma.bot.findFirst({
        where: { id: run.botId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
        select: { computerId: true },
      });
      if (!bot) return { error: "source bot is no longer available" } as const;
      preparedGroupId = target.group.id;
      try {
        // Ordinary group posts need downloadable attachments, including on a shared computer.
        prepared = await prepareBotFiles(
          deps,
          run,
          {
            botId: run.botId,
            computerId: bot.computerId,
            groupId: target.group.id,
            threadId: target.group.thread!.id,
          },
          paths,
          nonce,
          options?.fileSource,
          { requireArtifacts: true },
        );
      } catch (error) {
        if (error instanceof BotFileTransferError) return { error: error.message } as const;
        throw error;
      }
    }
  }

  let transactionKnownSettled = false;
  const committed = await deps.prisma
    .$transaction(async (tx) => {
      await lockSpaceForWork(tx, run.spaceId);
      const target = await resolve(tx);
      if ("error" in target) return target;
      try {
        await lockOwnedGroup(tx, run, target.group.id);
      } catch (error) {
        if (error instanceof IsolationError)
          return { error: "group is no longer available" } as const;
        throw error;
      }
      for (const threadId of [run.threadId, target.group.thread!.id].sort())
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      const source = await tx.run.findFirst({
        where: { ...run, status: "running" },
        select: { id: true },
      });
      if (!source) return { error: "source run is no longer active" } as const;
      await assertRunCanWriteHistory(tx, run.id, { lease: runLeaseFor(deps, run.id) });
      // Membership, active state and name uniqueness may have changed while waiting for locks.
      const checked = await resolve(tx);
      if ("error" in checked) return checked;
      if (
        checked.group.id !== target.group.id ||
        checked.group.thread?.id !== target.group.thread?.id
      )
        return { error: "group changed during delivery; retry with its group ID" } as const;
      const group = checked.group;
      const threadId = group.thread!.id;
      if (checked.previous) {
        const event = await tx.event.findFirst({
          where: {
            threadId,
            type: "thread.message.created",
            payload: { path: ["messageId"], equals: checked.previous.id },
          },
          select: { seq: true },
        });
        if (!event) return { error: "recorded group publication is incomplete" } as const;
        return {
          ok: true,
          groupId: group.id,
          groupName: group.name,
          threadId,
          messageId: checked.previous.id,
          eventSeq: event.seq,
        } as const;
      }
      if (preparedGroupId && preparedGroupId !== group.id)
        throw new BotFileTransferError("File destination changed during delivery");
      if (paths.length && !prepared)
        throw new BotFileTransferError("File preparation expired; retry the publication");
      const blocks: MessageBlock[] = [
        { kind: "text", text },
        ...((await prepared?.commit(tx)) ?? []),
      ];
      const message = await createThreadMessageInTransaction(tx, {
        threadId,
        role: "bot",
        botId: run.botId,
        blocks,
        clientNonce: nonce,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId,
        botId: run.botId,
        type: "thread.message.created",
        payload: { messageId: message.id, seq: message.seq, role: "bot", blocks },
      });
      await touchGroupUpdatedAt(tx, group.id);
      return {
        ok: true,
        groupId: group.id,
        groupName: group.name,
        threadId,
        messageId: message.id,
        eventSeq: event.seq,
      } as const;
    }, THREAD_LOCK_TRANSACTION_OPTIONS)
    .then((result) => {
      transactionKnownSettled = true;
      return result;
    })
    .catch((error: unknown) => {
      if (error instanceof RunHistoryWriteError) transactionKnownSettled = true;
      if (error instanceof BotFileTransferError) {
        transactionKnownSettled = true;
        return { error: error.message } as const;
      }
      throw error;
    })
    .finally(() => prepared?.cleanup(transactionKnownSettled));
  if ("error" in committed) return committed;
  await deps.events.notify(committed.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("group publication realtime notification", error);
  });
  return {
    ok: true,
    groupId: committed.groupId,
    groupName: committed.groupName,
    threadId: committed.threadId,
    messageId: committed.messageId,
  };
}
