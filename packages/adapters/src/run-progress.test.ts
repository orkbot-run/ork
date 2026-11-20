// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import {
  appendProgress,
  createReplyState,
  flushProgress,
  PUBLIC_PROGRESS_TEXT_MAX_LENGTH,
} from "./run-progress.js";

async function fixture(secrets: string[] = []) {
  const append = vi.fn(async (_input: { payload: Record<string, unknown> }) => undefined);
  const deps = {
    prisma: { message: { findMany: async () => [] } },
    events: { append },
  };
  const run = {
    id: "run-1",
    spaceId: "space-1",
    trigger: "user",
    replyMode: "chat",
  };
  const reply = await createReplyState(deps as never, run as never, secrets);
  const ctx = {
    deps,
    run,
    runId: run.id,
    bot: { id: "bot-1" },
    thread: { id: "thread-1", botId: "bot-1" },
    source: {
      ownerStartedRun: true,
      messagingChannelRun: false,
      callEndRun: false,
      callClientNonce: "call:our-call:utterance-1",
    },
    state: { reply },
    secrets,
    scripted: false,
    groupReplyOptional: false,
  } as unknown as RunContext;
  const payloads = () => append.mock.calls.map(([input]) => input.payload);
  return { ctx, append, reply, payloads };
}

describe("public chat progress for voice playback", () => {
  it("publishes cumulative text with the run and persisted call identity", async () => {
    const { ctx, append, reply, payloads } = await fixture();
    reply.pendingProgress = "First sentence.";
    await flushProgress(ctx);
    reply.pendingProgress = " Another sentence.";
    await flushProgress(ctx);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }));
    expect(payloads()).toEqual([
      {
        text: "First sentence.",
        streaming: true,
        publicText: "First sentence.",
        publicTextCallId: "our-call",
        publicTextSegmentStart: 0,
      },
      {
        delta: " Another sentence.",
        streaming: true,
        publicText: "First sentence. Another sentence.",
        publicTextCallId: "our-call",
        publicTextSegmentStart: 0,
      },
    ]);
  });

  it("retains the public prefix across tool status and transient text resets", async () => {
    const { ctx, reply, payloads } = await fixture();
    reply.pendingProgress = "Shown before a tool.";
    await flushProgress(ctx);
    await appendProgress(ctx, { text: "Private tool status.", activity: true });
    reply.hasStreamedText = false;
    reply.pendingProgress = "Shown after a tool.";
    await flushProgress(ctx);
    expect(payloads()[1]).not.toHaveProperty("publicText");
    expect(payloads()[2]?.publicText).toBe("Shown before a tool.\n\nShown after a tool.");
    expect(payloads()[2]?.publicTextSegmentStart).toBe("Shown before a tool.\n\n".length);
  });

  it.each([
    "explicit",
    "routine",
    "bot_message",
    "tickets",
    "scripted",
    "external",
    "non-owner",
    "call-end",
  ])("never marks private or final-only %s progress", async (mode) => {
    const { ctx, payloads } = await fixture();
    if (mode === "explicit") ctx.run.replyMode = "explicit";
    else if (mode === "scripted") ctx.scripted = true;
    else if (mode === "external") ctx.source.messagingChannelRun = true;
    else if (mode === "non-owner") ctx.source.ownerStartedRun = false;
    else if (mode === "call-end") ctx.source.callEndRun = true;
    else ctx.run.trigger = mode;
    await appendProgress(ctx, { text: "Private narration.", streaming: true });
    expect(payloads()[0]).not.toHaveProperty("publicText");
    expect(payloads()[0]).not.toHaveProperty("publicTextCallId");
  });

  it("does not associate typed messages with a live call", async () => {
    const { ctx, payloads } = await fixture();
    ctx.source.callClientNonce = "typed-message";
    await appendProgress(ctx, { text: "Typed response.", streaming: true });
    expect(payloads()[0]).not.toHaveProperty("publicText");
    expect(payloads()[0]).not.toHaveProperty("publicTextCallId");
  });

  it("only marks redacted text when a secret spans model chunks", async () => {
    const { ctx, reply, payloads } = await fixture(["super-secret"]);
    for (const text of ["The key is super-", "secret. Ready."]) {
      reply.pendingProgress += reply.redactor.push(text);
      await flushProgress(ctx);
    }
    reply.pendingProgress += reply.redactor.finish();
    await flushProgress(ctx);
    const shown = payloads().at(-1)?.publicText;
    expect(shown).toBe("The key is [redacted]. Ready.");
    expect(JSON.stringify(payloads())).not.toContain("super-secret");
  });

  it("does not publish a possible silent group ending", async () => {
    const { ctx, reply, append } = await fixture();
    ctx.groupReplyOptional = true;
    reply.pendingProgress = "NO_RESP";
    await flushProgress(ctx);
    expect(append).not.toHaveBeenCalled();
  });

  it("stops growing the optional marker at its bound without changing normal progress", async () => {
    const { ctx, payloads } = await fixture();
    await appendProgress(ctx, {
      text: "x".repeat(PUBLIC_PROGRESS_TEXT_MAX_LENGTH),
      streaming: true,
    });
    await appendProgress(ctx, { delta: "too long", streaming: true });
    await appendProgress(ctx, { delta: "tail", streaming: true });
    expect(payloads()[0]?.publicText).toHaveLength(PUBLIC_PROGRESS_TEXT_MAX_LENGTH);
    expect(payloads()[1]).toEqual({ delta: "too long", streaming: true });
    expect(payloads()[2]).toEqual({ delta: "tail", streaming: true });
  });
});
