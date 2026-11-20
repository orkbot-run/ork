// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { randomUUID } from "node:crypto";
import type { McpFormCard, McpFormRequest, McpFormResponse, MessageBlock } from "@orkbot/contracts";
import {
  MCP_FORM_MAX_ANSWER_LENGTH,
  McpFormAnswerSchema,
  McpFormRequestSchema,
  McpFormResponseSchema,
  MessageBlock as MessageBlockSchema,
  validateMcpFormResponse,
} from "@orkbot/contracts";
import { sanitizeJsonValue } from "@orkbot/core";
import type { Prisma, PrismaClient } from "./client.js";
import { ciphertextKeyId, decryptText, encryptText } from "./content-crypto.js";
import { contentEncryptionOf } from "./content-encryption.js";
import { appendEventInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { lockSpaceForWork } from "./spaces.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "./transaction-options.js";

// Reserved states keep this mailbox out of the external action approval/replay path.
const KIND = "mcp_form";
const PENDING = "mcp_form_pending";
const ANSWERED = "mcp_form_answered";
export const MCP_FORM_WAIT_MS = 10 * 60_000;

export class McpFormAnswerError extends Error {}

type Target = { spaceId: string; threadId: string; runId: string; botId: string };
type Turn = Target & { userId: string; leaseOwner: string; leaseFence: number };
type Prompt = { id: string; messageId: string; seq: number; expiresAt: Date };
type Ask = Extract<MessageBlock, { kind: "ask" }>;
type IdTarget = Target & { id: string; messageId: string };

function location(runId: string, id: string) {
  return { table: "external_effects", column: "result", rowId: id, owner: runId };
}

function ownLease(turn: Turn, now: Date): Prisma.RunWhereInput {
  return {
    id: turn.runId,
    spaceId: turn.spaceId,
    threadId: turn.threadId,
    botId: turn.botId,
    userId: turn.userId,
    status: "running",
    leaseOwner: turn.leaseOwner,
    leaseFence: turn.leaseFence,
    leaseExpiresAt: { gt: now },
  };
}

async function lockThread(tx: Prisma.TransactionClient, threadId: string) {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
}

/** The tool stays running and leased. Only its short-lived inbox and a normal message are saved. */
export async function openMcpForm(
  prisma: PrismaClient,
  turn: Turn,
  input: McpFormRequest,
): Promise<Prompt | undefined> {
  const request = McpFormRequestSchema.parse(sanitizeJsonValue(input));
  const { message, ...form } = request;
  const id = randomUUID();
  const blocks: MessageBlock[] = [
    {
      kind: "ask",
      text: message,
      status: "pending",
      mcpForm: { ...form, id, ownerUserId: turn.userId, status: "pending" },
    },
  ];
  await contentEncryptionOf(prisma)?.ring.all(turn.spaceId);
  return prisma.$transaction(async (tx) => {
    await lockSpaceForWork(tx, turn.spaceId);
    await lockThread(tx, turn.threadId);
    const now = new Date();
    const locked = await tx.run.updateMany({
      where: ownLease(turn, now),
      data: { leaseFence: turn.leaseFence },
    });
    if (locked.count !== 1) return;
    const expiresAt = new Date(now.getTime() + MCP_FORM_WAIT_MS);
    const stored = await createThreadMessageInTransaction(tx, {
      threadId: turn.threadId,
      role: "bot",
      botId: turn.botId,
      runId: turn.runId,
      blocks,
      markUnread: true,
    });
    await tx.externalEffect.create({
      data: {
        id,
        spaceId: turn.spaceId,
        runId: turn.runId,
        kind: KIND,
        status: PENDING,
        idempotencyKey: `mcp-form:${id}`,
        request: {
          messageId: stored.id,
          leaseOwner: turn.leaseOwner,
          leaseFence: turn.leaseFence,
          expiresAt: expiresAt.toISOString(),
        },
      },
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: turn.spaceId,
      threadId: turn.threadId,
      botId: turn.botId,
      runId: turn.runId,
      type: "thread.message.created",
      payload: { messageId: stored.id, seq: stored.seq, role: "bot", blocks },
    });
    return { id, messageId: stored.id, seq: event.seq, expiresAt };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}

export function parseMcpFormAnswer(answer: string) {
  if (!answer.trimStart().startsWith("{") || !answer.includes('"mcpFormId"')) return undefined;
  if (answer.length > MCP_FORM_MAX_ANSWER_LENGTH)
    throw new McpFormAnswerError("The form response is too large.");
  try {
    const parsed = McpFormAnswerSchema.safeParse(JSON.parse(answer));
    if (parsed.success) return parsed.data;
  } catch {
    // Report a bounded error without echoing the submitted content.
  }
  throw new McpFormAnswerError("The MCP form response is invalid.");
}

function binding(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("messageId" in value) ||
    !("leaseOwner" in value) ||
    !("leaseFence" in value) ||
    !("expiresAt" in value)
  )
    return;
  if (
    typeof value.messageId !== "string" ||
    typeof value.leaseOwner !== "string" ||
    typeof value.leaseFence !== "number" ||
    typeof value.expiresAt !== "string"
  )
    return;
  const expiresAt = new Date(value.expiresAt);
  if (!Number.isFinite(expiresAt.valueOf())) return;
  return {
    messageId: value.messageId,
    leaseOwner: value.leaseOwner,
    leaseFence: value.leaseFence,
    expiresAt,
  };
}

async function pendingCard(tx: Prisma.TransactionClient, target: IdTarget) {
  const message = await tx.message.findFirst({
    where: {
      id: target.messageId,
      threadId: target.threadId,
      runId: target.runId,
      role: "bot",
    },
    select: { id: true, seq: true, blocks: true },
  });
  const parsed = MessageBlockSchema.array().safeParse(message?.blocks);
  if (!message || !parsed.success) return;
  const ask = parsed.data.find(
    (block): block is Ask =>
      block.kind === "ask" &&
      block.status === "pending" &&
      block.mcpForm?.id === target.id &&
      block.mcpForm.status === "pending",
  );
  if (ask?.mcpForm) return { message, blocks: parsed.data, ask, form: ask.mcpForm };
}

async function settleCard(
  tx: Prisma.TransactionClient,
  target: IdTarget,
  pending: NonNullable<Awaited<ReturnType<typeof pendingCard>>>,
  status: Exclude<McpFormCard["status"], "pending">,
) {
  const blocks = pending.blocks.map(
    (block): MessageBlock =>
      block === pending.ask
        ? {
            ...pending.ask,
            status: "answered",
            answer: status,
            mcpForm: { ...pending.form, status, fields: [] },
          }
        : block,
  );
  await tx.message.update({ where: { id: pending.message.id }, data: { blocks } });
  return appendEventInTransaction(tx, {
    spaceId: target.spaceId,
    threadId: target.threadId,
    botId: target.botId,
    runId: target.runId,
    type: "thread.message.updated",
    payload: { messageId: pending.message.id, seq: pending.message.seq, role: "bot", blocks },
  });
}

/** Only the current run initiator and exact outstanding form can write to this inbox. */
export async function answerMcpForm(
  prisma: PrismaClient,
  input: Omit<IdTarget, "id" | "botId"> & {
    userId: string;
    answer: NonNullable<ReturnType<typeof parseMcpFormAnswer>>;
  },
): Promise<number | undefined> {
  const { mcpFormId: id, ...response } = input.answer;
  const ring = contentEncryptionOf(prisma)?.ring;
  await ring?.all(input.spaceId);
  const key = ring?.encryptWrites ? await ring.current(input.spaceId) : undefined;
  return prisma.$transaction(async (tx) => {
    await lockSpaceForWork(tx, input.spaceId);
    await lockThread(tx, input.threadId);
    const effect = await tx.externalEffect.findFirst({
      where: { id, kind: KIND, status: PENDING, runId: input.runId, spaceId: input.spaceId },
      select: {
        request: true,
        run: {
          select: {
            botId: true,
            threadId: true,
            userId: true,
            status: true,
            leaseOwner: true,
            leaseFence: true,
            leaseExpiresAt: true,
          },
        },
      },
    });
    const scope = effect && binding(effect.request);
    const now = new Date();
    if (
      !effect ||
      !scope ||
      scope.messageId !== input.messageId ||
      scope.expiresAt <= now ||
      effect.run.threadId !== input.threadId ||
      effect.run.userId !== input.userId ||
      effect.run.status !== "running" ||
      effect.run.leaseOwner !== scope.leaseOwner ||
      effect.run.leaseFence !== scope.leaseFence ||
      !effect.run.leaseExpiresAt ||
      effect.run.leaseExpiresAt <= now
    )
      return;
    const target = { ...input, id, botId: effect.run.botId };
    const locked = await tx.run.updateMany({
      where: ownLease(
        { ...target, leaseOwner: scope.leaseOwner, leaseFence: scope.leaseFence },
        now,
      ),
      data: { leaseFence: scope.leaseFence },
    });
    if (locked.count !== 1) return;
    const pending = await pendingCard(tx, target);
    if (!pending) return;
    if (!validateMcpFormResponse(pending.form.fields, response))
      throw new McpFormAnswerError("Check the required fields and formats.");
    const json = JSON.stringify(response);
    const result = key ? encryptText(key, location(input.runId, id), json) : json;
    await tx.externalEffect.update({ where: { id }, data: { status: ANSWERED, result } });
    const status =
      response.action === "accept"
        ? "accepted"
        : response.action === "decline"
          ? "declined"
          : "cancelled";
    return (await settleCard(tx, target, pending, status)).seq;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}

/** Content never rides the chat feed. The process holding the live call reads it once. */
export async function readMcpFormAnswer(
  prisma: PrismaClient,
  turn: Turn,
  id: string,
): Promise<McpFormResponse | undefined> {
  const found = await prisma.externalEffect.findFirst({
    where: {
      id,
      kind: KIND,
      status: ANSWERED,
      spaceId: turn.spaceId,
      runId: turn.runId,
      run: ownLease(turn, new Date()),
    },
    select: { result: true, request: true },
  });
  const scope = found && binding(found.request);
  if (
    !found ||
    !scope ||
    typeof found.result !== "string" ||
    scope.leaseOwner !== turn.leaseOwner ||
    scope.leaseFence !== turn.leaseFence
  )
    return;
  const keyId = ciphertextKeyId(found.result);
  const key = keyId ? await contentEncryptionOf(prisma)?.ring.byId(keyId) : undefined;
  if (keyId && (!key || key.spaceId !== turn.spaceId))
    throw new Error("MCP form response encryption is unavailable.");
  const decoded = key ? decryptText(key, location(turn.runId, id), found.result) : found.result;
  return McpFormResponseSchema.parse(JSON.parse(decoded));
}

/** Drops all answer content, and marks a card still awaiting input as expired. */
export async function closeMcpForm(
  prisma: PrismaClient,
  target: IdTarget,
  onlyStale = false,
): Promise<number | undefined> {
  await contentEncryptionOf(prisma)?.ring.all(target.spaceId);
  return prisma.$transaction(async (tx) => {
    await lockThread(tx, target.threadId);
    const row = await tx.externalEffect.findFirst({
      where: { id: target.id, runId: target.runId, spaceId: target.spaceId, kind: KIND },
      select: {
        status: true,
        request: true,
        run: { select: { status: true, leaseOwner: true, leaseFence: true, leaseExpiresAt: true } },
      },
    });
    const scope = row && binding(row.request);
    if (!row || !scope || scope.messageId !== target.messageId) return;
    const now = new Date();
    if (
      onlyStale &&
      scope.expiresAt > now &&
      row.run.status === "running" &&
      row.run.leaseOwner === scope.leaseOwner &&
      row.run.leaseFence === scope.leaseFence &&
      row.run.leaseExpiresAt &&
      row.run.leaseExpiresAt > now
    )
      return;
    await tx.externalEffect.delete({ where: { id: target.id } });
    if (row.status !== PENDING) return;
    const pending = await pendingCard(tx, target);
    if (!pending) return;
    return (await settleCard(tx, target, pending, "expired")).seq;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}

export async function reconcileMcpForms(
  prisma: PrismaClient,
  notify: (threadId: string, seq: number) => Promise<void>,
) {
  const now = new Date();
  const orphaned = await prisma.$queryRaw<Array<IdTarget>>`
    SELECT e.id, e."spaceId", e."runId", r."threadId", r."botId", e.request->>'messageId' AS "messageId"
    FROM external_effects e JOIN runs r ON r.id = e."runId"
    WHERE e.kind = ${KIND} AND (
      r.status <> 'running' OR r."leaseOwner" IS DISTINCT FROM e.request->>'leaseOwner'
      OR r."leaseFence"::text <> e.request->>'leaseFence'
      OR r."leaseExpiresAt" IS NULL OR r."leaseExpiresAt" <= ${now}
      OR e."createdAt" <= ${new Date(now.getTime() - MCP_FORM_WAIT_MS)}
    ) ORDER BY e."createdAt" LIMIT 50`;
  for (const target of orphaned) {
    const seq = await closeMcpForm(prisma, target, true);
    if (seq !== undefined) await notify(target.threadId, seq);
  }
}
