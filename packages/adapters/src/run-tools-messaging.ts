// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited messaging behavior is preserved; bounded delegated files are an Ork addition.

import { runContinueJob } from "@orkbot/adapter-kit";
import { isBackgroundRunTrigger, redactSecrets } from "@orkbot/core";
import { createBackgroundHelper, findBackgroundHelper } from "@orkbot/db";
import {
  connectAgent,
  messageConnectedAgent,
  respondAgentConnection,
} from "./agent-connections.js";
import { messageBot } from "./bot-messages.js";
import { endCallFromTool, requestUserCall } from "./call-request.js";
import { handoffToGroupBot } from "./group-handoff.js";
import { isRunTainted } from "./run-context.js";
import { publishMessage } from "./run-messages.js";
import {
  canPostLongTaskHeadsUp,
  canPublishDurableProgress,
  flushProgress,
  nextProgressNonce,
  progressSinceBudgetStart,
  publishMidTurnNarration,
  showNarrationStatus,
} from "./run-progress.js";
import type { ToolHandlers } from "./run-tool-gate.js";
import {
  clampUserProgressMessage,
  isProgressMessageTruncated,
  MID_TURN_PROGRESS_MIN_TURN_AGE_MS,
  messageUserMaxLength,
  midTurnProgressBudgetUsed,
} from "./user-progress.js";

/** Messages to the user, other bots and connected agents, and calls. */
export const messagingTools: ToolHandlers = {
  async call_user(ctx, call) {
    const { deps, run, thread } = ctx;
    const { args } = call;
    if (
      ctx.source.messagingChannelRun ||
      thread.groupId ||
      ctx.source.voiceCall ||
      isBackgroundRunTrigger(run.trigger)
    ) {
      return call.finish({ error: "Calls require a one-to-one chat." });
    }
    return call.finish(
      await requestUserCall(deps, run, {
        reason: String(args.reason ?? ""),
        opening: String(args.opening ?? ""),
      }),
    );
  },
  async end_call(ctx, call) {
    const { deps, run, bot, thread } = ctx;
    const { args } = call;
    return call.finish(
      await endCallFromTool(
        deps,
        run,
        thread.id,
        bot.id,
        args,
        ctx.source.callClientNonce,
        ctx.source.callEndRun,
      ),
    );
  },
  async request_takeover() {
    return { ok: true };
  },
  async run_subagent(ctx, call) {
    const { args } = call;
    if (args.background === true) {
      if (
        !ctx.source.ownerStartedRun ||
        ctx.source.messagingChannelRun ||
        ctx.run.userId !== ctx.bot.userId
      ) {
        return call.finish({
          error: "Background helpers are available only in the bot owner's app conversation.",
        });
      }
      const helperInput = {
        spaceId: ctx.run.spaceId,
        parentThreadId: ctx.thread.id,
        parentRunId: ctx.runId,
        parentLease: { owner: ctx.workerId, fence: ctx.fence },
        callId: call.effectKey,
      };
      const existing = await findBackgroundHelper(ctx.deps.prisma, helperInput);
      if (existing) {
        await ctx.deps.jobs.enqueue(runContinueJob(existing.runId)).catch(() => undefined);
        return call.finish({
          ok: true,
          agentId: existing.runId,
          note: "The helper is working in the background. Its result will return to this conversation.",
        });
      }
      if (await isRunTainted(ctx)) {
        return call.finish({
          error: "Background helpers cannot start after outside content enters this run.",
        });
      }
      if (args.model_provider || args.model_id) {
        return call.finish({ error: "Background helpers use the parent bot's configured model." });
      }
      const name = redactSecrets(String(args.name ?? ""), ctx.secrets);
      const task = redactSecrets(String(args.task ?? ""), ctx.secrets);
      const instructions = redactSecrets(String(args.instructions ?? ""), ctx.secrets).trim();
      if (!name.trim() || !task.trim()) return call.finish({ error: "name and task are required" });
      const helper = await createBackgroundHelper(ctx.deps.prisma, {
        ...helperInput,
        name,
        task: instructions
          ? `${task}\n\nAdditional instructions from the parent bot:\n${instructions}`
          : task,
      });
      if (helper.eventSeq !== null) {
        await ctx.deps.events.notify(ctx.thread.id, helper.eventSeq).catch(() => undefined);
      }
      await ctx.deps.jobs.enqueue(runContinueJob(helper.runId)).catch(() => undefined);
      return call.finish({
        ok: true,
        agentId: helper.runId,
        note: "The helper is working in the background. Its result will return to this conversation.",
      });
    }
    return {
      ok: true,
      result: String(args.task ?? "done."),
    };
  },
  async message_user(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    const { reply } = ctx.state;
    const rawMessage = redactSecrets(String(args.message ?? ""), ctx.secrets);
    const maxLength = messageUserMaxLength();
    const text = clampUserProgressMessage(rawMessage, maxLength);
    if (!text) return call.finish({ error: "message is required" });
    const truncated = isProgressMessageTruncated(rawMessage, maxLength);
    await flushProgress(ctx);
    // Text written before an answer to the person's mid-task message doesn't use up the
    // allowance meant for that answer.
    const answering = reply.steeringReplyPending;
    reply.steeringReplyPending = false;
    await showNarrationStatus(ctx, await publishMidTurnNarration(ctx));
    // A mid-task message handled meanwhile may have granted a new allowance; keep it.
    reply.steeringReplyPending ||= answering;
    if (!canPublishDurableProgress(reply) && !canPostLongTaskHeadsUp(ctx)) {
      return call.finish({
        ok: true,
        note: midTurnProgressBudgetUsed(progressSinceBudgetStart(reply))
          ? "This update was not posted. The chat already has enough interim messages for this run. Do not send more progress updates — keep working and put everything in your final reply."
          : `This update was not posted because the turn just started. Keep working and put anything the person needs in your final reply. Once the turn has run ${MID_TURN_PROGRESS_MIN_TURN_AGE_MS / 1000} seconds, a later update can be posted.`,
      });
    }
    await publishMessage(deps, run, "bot", [{ kind: "text", text }], true, nextProgressNonce(ctx));
    reply.midTurnUserTexts.push(text);
    reply.publishedMidTurnUserMessage = true;
    return call.finish(
      truncated
        ? {
            ok: true,
            truncated: true,
            note: `This progress update was cut off at ${maxLength} characters and the user only saw the truncated version above — it did NOT deliver your full content. message_user is for short interim beats only, never the final answer. Put your complete answer in your normal final reply instead of relying on this truncated update.`,
          }
        : { ok: true },
    );
  },
  async message_bot(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args, effectKey } = call;
    const sent = await messageBot(
      deps,
      { ...run, sourceMessageId: run.sourceMessageId },
      { id: bot.id, name: bot.name },
      {
        bot_id: args.bot_id ? String(args.bot_id) : undefined,
        confirm_name: args.confirm_name ? String(args.confirm_name) : undefined,
        message: redactSecrets(String(args.message ?? ""), ctx.secrets),
        intent: args.intent as "request" | "result" | "question" | "status" | "fyi" | undefined,
        deliveryKey: effectKey,
        files: args.files as string[] | undefined,
      },
      {
        fileSource: {
          computerId: ctx.computer.stored.id,
          mode: ctx.computer.mode,
          computer: () => ctx.computer.get("tool", call.name),
          context: ctx.context,
        },
      },
    );
    if (!sent.ok) return call.finish({ error: sent.error });
    return call.finish({
      ok: true,
      botId: sent.botId,
      name: sent.name,
      note: sent.note,
    });
  },
  async connect_agent(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const result = await connectAgent(
      deps,
      { ...run, sourceMessageId: run.sourceMessageId },
      { id: bot.id, name: bot.name },
      { address: args.address ? String(args.address) : undefined },
    );
    if (!result.ok) return call.finish({ error: result.error });
    return call.finish(result);
  },
  async respond_agent_connection(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const result = await respondAgentConnection(
      deps,
      { ...run, sourceMessageId: run.sourceMessageId },
      { id: bot.id, name: bot.name },
      {
        accept: Boolean(args.accept),
        connectionId: String(args.connection_id ?? ""),
        connectionVersion: Number(args.connection_version ?? 0),
      },
    );
    if (!result.ok) return call.finish({ error: result.error });
    return call.finish(result);
  },
  async message_agent(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args, effectKey } = call;
    const result = await messageConnectedAgent(
      deps,
      { ...run, sourceMessageId: run.sourceMessageId },
      { id: bot.id, name: bot.name },
      {
        address: args.address ? String(args.address) : undefined,
        message: redactSecrets(String(args.message ?? ""), ctx.secrets),
        deliveryKey: effectKey,
      },
    );
    if (!result.ok) return call.finish({ error: result.error });
    return call.finish(result);
  },
  async handoff_to_bot(ctx, call) {
    const { deps, run, thread } = ctx;
    const { args, effectKey } = call;
    const groupId = args.group_id ? String(args.group_id).trim() : thread.groupId;
    if (!groupId) return call.finish({ error: "group_id is required outside a group chat" });
    const result = await handoffToGroupBot(
      deps,
      run,
      groupId,
      {
        bot_id: args.bot_id ? String(args.bot_id) : undefined,
        confirm_name: args.confirm_name ? String(args.confirm_name) : undefined,
        message: redactSecrets(String(args.message ?? ""), ctx.secrets),
        deliveryKey: effectKey,
        files: args.files as string[] | undefined,
      },
      {
        fileSource: {
          computerId: ctx.computer.stored.id,
          mode: ctx.computer.mode,
          computer: () => ctx.computer.get("tool", call.name),
          context: ctx.context,
        },
      },
    );
    if ("ok" in result && result.ok && thread.groupId) ctx.state.handedOff = true;
    return call.finish(result);
  },
};
