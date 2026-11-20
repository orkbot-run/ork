// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { McpFormRequest, McpFormResponse } from "@orkbot/contracts";
import { closeMcpForm, openMcpForm, readMcpFormAnswer } from "@orkbot/db";
import { getLogger } from "@orkbot/logging";
import type { RunContext } from "./run-context.js";

/** Await a person in the current leased call without suspending and replaying the tool. */
export async function askMcpForm(
  ctx: RunContext,
  request: McpFormRequest,
  requestSignal: AbortSignal,
): Promise<McpFormResponse> {
  if (!ctx.source.ownerStartedRun || ctx.source.messagingChannelRun || ctx.source.callEndRun)
    return { action: "decline" };
  const { deps, run, thread, bot, workerId, fence } = ctx;
  const signal = AbortSignal.any([ctx.context.signal, requestSignal]);
  if (signal.aborted) return { action: "cancel" };
  const turn = {
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    runId: run.id,
    userId: run.userId,
    leaseOwner: workerId,
    leaseFence: fence,
  };
  const prompt = await openMcpForm(deps.prisma, turn, request);
  if (!prompt) return { action: "cancel" };
  const notify = (seq: number) =>
    deps.events.notify(thread.id, seq).catch((error: unknown) => {
      getLogger().error("mcp form realtime notification", error);
    });
  const deadline = AbortSignal.timeout(Math.max(0, prompt.expiresAt.getTime() - Date.now()));
  const waiting = AbortSignal.any([signal, deadline]);
  try {
    await notify(prompt.seq);
    for await (const event of deps.events.follow(thread.id, prompt.seq, waiting)) {
      if (waiting.aborted) break;
      if (event.runId !== run.id) continue;
      if (event.type === "thread.message.updated" && event.payload.messageId === prompt.messageId) {
        const response = await readMcpFormAnswer(deps.prisma, turn, prompt.id);
        return waiting.aborted || !response ? { action: "cancel" } : response;
      }
      if (
        event.type === "run.cancelled" ||
        event.type === "run.completed" ||
        event.type === "run.failed"
      )
        break;
    }
    return { action: "cancel" };
  } finally {
    try {
      const seq = await closeMcpForm(deps.prisma, {
        ...turn,
        id: prompt.id,
        messageId: prompt.messageId,
      });
      if (seq !== undefined) await notify(seq);
    } catch (error) {
      getLogger().error("mcp form cleanup", error);
    }
  }
}
