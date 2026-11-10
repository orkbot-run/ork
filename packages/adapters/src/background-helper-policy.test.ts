// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type * as DbModule from "@orkbot/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("@orkbot/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  findBackgroundHelper: lookup,
}));

import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { messagingTools } from "./run-tools-messaging.js";

describe("background helper admission", () => {
  beforeEach(() => lookup.mockReset().mockResolvedValue(null));
  it("recovers an existing helper after a retry without starting another one", async () => {
    lookup.mockResolvedValueOnce({ threadId: "child", runId: "helper" });
    const enqueue = vi.fn(async () => undefined);
    const ctx = {
      source: { ownerStartedRun: true, messagingChannelRun: false },
      run: { userId: "owner", spaceId: "space" },
      bot: { userId: "owner" },
      thread: { id: "parent" },
      runId: "run",
      workerId: "worker",
      fence: 2,
      state: { tainted: true },
      deps: { prisma: {}, jobs: { enqueue } },
    } as unknown as RunContext;
    const call = {
      effectKey: "same-call",
      args: { background: true, name: "helper", task: "work" },
      finish: async (result: unknown) => result,
    } as unknown as ToolCall;
    await expect(messagingTools.run_subagent!(ctx, call)).resolves.toMatchObject({
      ok: true,
      agentId: "helper",
    });
    expect(enqueue).toHaveBeenCalledOnce();
  });
  it("rejects a resumed attempt when its earlier context cannot be trusted", async () => {
    const ctx = {
      source: { ownerStartedRun: true, messagingChannelRun: false },
      run: { userId: "owner" },
      bot: { userId: "owner" },
      runId: "run",
      thread: { id: "parent" },
      state: { tainted: false },
      trust: { receivedOutsideMessage: vi.fn(async () => false) },
      deps: { prisma: { attempt: { count: vi.fn(async () => 2) } } },
    } as unknown as RunContext;
    const call = {
      args: { background: true, name: "helper", task: "work" },
      finish: async (result: unknown) => result,
    } as unknown as ToolCall;
    await expect(messagingTools.run_subagent!(ctx, call)).resolves.toEqual({
      error: "Background helpers cannot start after outside content enters this run.",
    });
    expect(ctx.state.tainted).toBe(true);
  });
  it("rejects a run tainted by mid-turn outside content before creating a helper", async () => {
    const create = vi.fn();
    const ctx = {
      source: { ownerStartedRun: true, messagingChannelRun: false },
      run: { userId: "owner" },
      bot: { userId: "owner" },
      thread: { id: "parent" },
      state: { tainted: true },
      deps: { prisma: { thread: { create } } },
    } as unknown as RunContext;
    const call = {
      args: { background: true, name: "helper", task: "work" },
      finish: async (result: unknown) => result,
    } as unknown as ToolCall;
    await expect(messagingTools.run_subagent!(ctx, call)).resolves.toEqual({
      error: "Background helpers cannot start after outside content enters this run.",
    });
    expect(create).not.toHaveBeenCalled();
  });
  it("rechecks whether an outside message arrived during an owner run", async () => {
    const create = vi.fn();
    const ctx = {
      source: { ownerStartedRun: true, messagingChannelRun: false },
      run: { userId: "owner" },
      bot: { userId: "owner" },
      thread: { id: "parent" },
      state: { tainted: false, earlierAttempt: Promise.resolve(false) },
      trust: { receivedOutsideMessage: vi.fn(async () => true) },
      deps: { prisma: { thread: { create } } },
    } as unknown as RunContext;
    const call = {
      args: { background: true, name: "helper", task: "work" },
      finish: async (result: unknown) => result,
    } as unknown as ToolCall;
    await expect(messagingTools.run_subagent!(ctx, call)).resolves.toEqual({
      error: "Background helpers cannot start after outside content enters this run.",
    });
    expect(ctx.state.tainted).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });
  it.each([
    { ownerStartedRun: false, messagingChannelRun: true, runUserId: "owner" },
    { ownerStartedRun: false, messagingChannelRun: false, runUserId: "owner" },
    { ownerStartedRun: true, messagingChannelRun: true, runUserId: "owner" },
    { ownerStartedRun: true, messagingChannelRun: false, runUserId: "other-member" },
  ])("rejects untrusted or non-owner contexts before creating a helper: %o", async (source) => {
    const create = vi.fn();
    const ctx = {
      source: {
        ownerStartedRun: source.ownerStartedRun,
        messagingChannelRun: source.messagingChannelRun,
      },
      run: { userId: source.runUserId },
      bot: { userId: "owner" },
      deps: { prisma: { thread: { create } } },
    } as unknown as RunContext;
    const call = {
      args: { background: true, name: "helper", task: "work" },
      finish: async (result: unknown) => result,
    } as unknown as ToolCall;
    await expect(messagingTools.run_subagent!(ctx, call)).resolves.toEqual({
      error: "Background helpers are available only in the bot owner's app conversation.",
    });
    expect(create).not.toHaveBeenCalled();
  });
});
