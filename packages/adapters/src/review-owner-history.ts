// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ExecutorDeps } from "./executor-deps.js";

const HISTORY_MESSAGES = 4;
const HISTORY_CHARS = 2_000;
const SNAPSHOT_MESSAGES = 80;

const messageSelect = {
  id: true,
  threadId: true,
  seq: true,
  role: true,
  blocks: true,
  clientNonce: true,
  sourceRuns: {
    select: { id: true, userId: true, spaceId: true, threadId: true, trigger: true },
  },
  steeringMessages: { select: { userId: true, originTrigger: true } },
} as const;

function ownerText(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const texts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block)) return undefined;
    // Every other block can carry incoming, delegated or generated text.
    if (!["text", "file", "image"].includes(block.kind)) return undefined;
    if (block.kind === "text") {
      if (typeof block.text !== "string") return undefined;
      texts.push(block.text);
    }
  }
  return texts.join("\n").trim() || undefined;
}

/** Review context only: this loader never contributes to trusted sites or authorization. */
export function createReviewOwnerHistoryLoader(
  deps: ExecutorDeps,
  input: {
    run: { userId: string; spaceId: string; trigger: string; sourceMessageId?: string | null };
    runId: string;
    botId: string;
    ownerStartedRun: boolean;
    messagingChannelRun: boolean;
  },
) {
  let snapshot: Promise<{ prior: string[]; current?: string }> | undefined;
  const load = (): Promise<{ prior: string[]; current?: string }> =>
    (snapshot ??= (async () => {
      const { run } = input;
      if (
        !run.sourceMessageId ||
        input.messagingChannelRun ||
        !(input.ownerStartedRun || run.trigger === "messaging")
      )
        return { prior: [] };
      const source = await deps.prisma.message.findUnique({
        where: { id: run.sourceMessageId },
        select: messageSelect,
      });
      if (source?.role !== "user" || !Number.isInteger(source.seq) || source.seq < 0)
        return { prior: [] };
      const thread = await deps.prisma.thread.findFirst({
        where: {
          id: source.threadId,
          userId: run.userId,
          spaceId: run.spaceId,
          botId: input.botId,
          groupId: null,
          parentThreadId: null,
        },
        select: { externalConversationId: true },
      });
      if (!thread) return { prior: [] };
      const firstSeq = Math.max(0, source.seq - SNAPSHOT_MESSAGES);
      const rows = await deps.prisma.message.findMany({
        where: { threadId: source.threadId, seq: { gte: firstSeq, lte: source.seq } },
        orderBy: { seq: "asc" },
        take: SNAPSHOT_MESSAGES + 1,
        select: messageSelect,
      });
      if (
        rows.length !== source.seq - firstSeq + 1 ||
        rows.some(
          (row, index) => row.threadId !== source.threadId || row.seq !== firstSeq + index,
        ) ||
        rows.at(-1)?.id !== source.id
      )
        return { prior: [] };

      if (thread.externalConversationId) {
        if (run.trigger !== "messaging") return { prior: [] };
        const conversation = await deps.prisma.externalConversation.findFirst({
          where: {
            id: thread.externalConversationId,
            userId: run.userId,
            spaceId: run.spaceId,
            botId: input.botId,
            isDm: true,
          },
          select: { id: true, provider: true, workspaceId: true },
        });
        if (!conversation) return { prior: [] };
        const prefix = `teamchat:${conversation.provider}:`;
        if (!source.clientNonce?.startsWith(prefix)) return { prior: [] };
        const waking = await deps.prisma.externalMessage.findUnique({
          where: {
            externalConversationId_providerEventId: {
              externalConversationId: conversation.id,
              providerEventId: source.clientNonce.slice(prefix.length),
            },
          },
        });
        if (!waking || waking.runId !== input.runId) return { prior: [] };
        let batchIds = [waking.id];
        if (waking.batchContext) {
          const batch: unknown = JSON.parse(waking.batchContext);
          if (
            !batch ||
            typeof batch !== "object" ||
            !("messageIds" in batch) ||
            !Array.isArray(batch.messageIds) ||
            !batch.messageIds.length ||
            !batch.messageIds.every((id): id is string => typeof id === "string") ||
            !batch.messageIds.includes(waking.id) ||
            batch.messageIds.length > SNAPSHOT_MESSAGES
          )
            return { prior: [] };
          batchIds = [...new Set(batch.messageIds)];
        }
        const current = await deps.prisma.externalMessage.findMany({
          where: { externalConversationId: conversation.id, id: { in: batchIds } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        if (current.length !== batchIds.length || current.some((row) => !batchIds.includes(row.id)))
          return { prior: [] };
        const installation = await deps.prisma.messagingInstallation.findUnique({
          where: {
            provider_workspaceId: {
              provider: conversation.provider,
              workspaceId: conversation.workspaceId,
            },
          },
          select: { ownerAddress: true, userId: true, botId: true },
        });
        const identities = await deps.prisma.messagingIdentity.findMany({
          where: {
            provider: conversation.provider,
            userId: run.userId,
            spaceId: run.spaceId,
            botId: input.botId,
          },
          select: { address: true },
        });
        const addresses = new Set(identities.map((row) => row.address));
        if (
          installation?.userId === run.userId &&
          installation.botId === input.botId &&
          installation.ownerAddress
        )
          addresses.add(installation.ownerAddress);
        const fromOwner = (row: typeof waking) =>
          row.externalConversationId === conversation.id &&
          !row.senderIsBot &&
          addresses.has(row.senderId);
        if (!current.every(fromOwner)) return { prior: [] };
        const earliest = current[0];
        if (!earliest) return { prior: [] };
        const previous = await deps.prisma.externalMessage.findMany({
          where: {
            externalConversationId: conversation.id,
            OR: [
              { createdAt: { lt: earliest.createdAt } },
              { createdAt: earliest.createdAt, id: { lt: earliest.id } },
            ],
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: SNAPSHOT_MESSAGES,
        });
        return {
          prior: previous
            .filter(fromOwner)
            .filter((row) => row.content.trim())
            .slice(0, HISTORY_MESSAGES)
            .reverse()
            .map((row) => row.content.slice(0, HISTORY_CHARS)),
          current: current
            .map((row) => row.content)
            .filter((text) => text.trim())
            .join("\n"),
        };
      }
      const textFor = (row: (typeof rows)[number]) => {
        if (!ownerText(row.blocks)) return undefined;
        if (!row.clientNonce?.startsWith("messaging:")) return ownerText(row.blocks);
        // The display body also contains provider media URLs and upload errors.
        const texts = (row.blocks as Array<{ kind: string; ownerText?: unknown }>).filter(
          (block) => block.kind === "text",
        );
        if (!texts.length || texts.some((block) => typeof block.ownerText !== "string"))
          return undefined;
        return (
          texts
            .map((block) => block.ownerText as string)
            .join("\n")
            .trim() || undefined
        );
      };
      // Direct-message delivery writes this nonce only after mapping the verified
      // provider sender to this owner. Group delivery uses channel_message blocks.
      // A client can choose its nonce, but cannot choose the messaging trigger.
      const isOwner = (row: (typeof rows)[number]) => {
        if (row.role !== "user" || !textFor(row)) return false;
        const direct = /^messaging:[^:]+:.+/.test(row.clientNonce ?? "");
        if (row.clientNonce?.startsWith("teamchat:")) return false;
        const allowedTrigger = (trigger: string | null) =>
          direct ? trigger === "messaging" : trigger === "user" || trigger === "follow_up";
        return (
          (row.sourceRuns.length > 0 || row.steeringMessages.length > 0) &&
          row.sourceRuns.every(
            (origin) =>
              origin.userId === run.userId &&
              origin.spaceId === run.spaceId &&
              origin.threadId === source.threadId &&
              allowedTrigger(origin.trigger),
          ) &&
          row.steeringMessages.every(
            (origin) =>
              origin.userId === run.userId &&
              (direct ? origin.originTrigger === "messaging" : origin.originTrigger === null),
          )
        );
      };
      if (
        !isOwner(source) ||
        !source.sourceRuns.some(
          (origin) => origin.id === input.runId && origin.trigger === run.trigger,
        )
      )
        return { prior: [] };
      return {
        prior: rows
          .slice(0, -1)
          .filter(isOwner)
          .map((row) => textFor(row)!)
          .slice(-HISTORY_MESSAGES)
          .map((text) => text.slice(0, HISTORY_CHARS)),
        ...(run.trigger === "messaging" ? { current: textFor(source) } : {}),
      };
    })().catch(() => ({ prior: [] })));
  return {
    loadPriorOwnerMessages: async () => (await load()).prior,
    loadCurrentOwnerMessage: async () => (await load()).current,
  };
}
