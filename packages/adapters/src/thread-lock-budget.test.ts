// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AdapterContext } from "@orkbot/adapter-kit";
import * as db from "@orkbot/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnBot } from "./child-bots.js";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import { executeCloudAgentTool } from "./cloud-agent-service.js";
import { addMcpServerFromTool } from "./mcp-server-tool.js";
import * as mediaTools from "./media-generation-tools.js";
import { mediaDelivery, pollMediaVideo } from "./media-video-poll.js";
import { pollPurchase } from "./purchase-poll.js";
import { postRoutineWatchMessage } from "./routine-watch.js";
import { publishMessage } from "./run-messages.js";

const run = {
  id: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  threadId: "thread-1",
  botId: "bot-1",
  trigger: "user",
};
const context: AdapterContext & { botId: string } = {
  ...run,
  operationId: "operation-1",
  traceId: "trace-1",
  signal: new AbortController().signal,
};
const budget = { timeout: 20_000 };

function transactionBoundary() {
  const failure = new Error("fixture transaction body is not entered");
  const $transaction = vi.fn().mockRejectedValue(failure);
  return { failure, $transaction };
}

afterEach(() => vi.restoreAllMocks());

describe("adapter thread-lock transaction budgets", () => {
  it("budgets the initial delegated prompt after bot creation", async () => {
    const { failure, $transaction } = transactionBoundary();
    const createBot = vi.fn(async () => ({
      id: run.botId,
      name: "Helper",
      threadId: run.threadId,
    }));
    vi.spyOn(db, "createRepos").mockReturnValue({ createBot } as never);
    const prisma = { $transaction, run: { findUnique: vi.fn(async () => null) } };
    await expect(
      spawnBot({ prisma, jobs: {} } as never, {
        spawnedBy: { id: "parent-1", name: "Parent", spaceId: run.spaceId, userId: run.userId },
        runId: run.id,
        spawnKey: "spawn-1",
        name: "Helper",
        prompt: "Check the result",
      }),
    ).rejects.toBe(failure);
    expect(createBot).toHaveBeenCalledOnce();
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });

  it("budgets a cloud-agent intent and its card", async () => {
    const { failure, $transaction } = transactionBoundary();
    await expect(
      executeCloudAgentTool(
        {
          prisma: { $transaction },
          cloudAgent: { key: "fake", spaceId: run.spaceId, provider: {} },
        } as never,
        context,
        run,
        "cloud_agent_launch",
        { prompt: "Check the result" },
      ),
    ).rejects.toBe(failure);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });

  it("budgets cloud-agent settlement even when the recipient has gone", async () => {
    const { $transaction } = transactionBoundary();
    const deps = {
      prisma: {
        $transaction,
        cloudAgent: {
          findFirst: vi.fn(async () => ({
            ...run,
            id: "agent-1",
            nextPollAt: new Date(),
            version: 1,
          })),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        message: { findFirst: vi.fn(async () => null) },
        spaceMember: { findUnique: vi.fn(async () => null) },
        bot: { findFirst: vi.fn(async () => null) },
      },
      jobs: { enqueue: vi.fn(async () => undefined) },
      cloudAgent: { key: "fake", spaceId: run.spaceId, provider: {} },
    };
    await pollCloudAgent(deps as never, { agentId: "agent-1" });
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });

  it("budgets purchase expiry before its wake is written", async () => {
    const { failure, $transaction } = transactionBoundary();
    await expect(
      pollPurchase(
        {
          prisma: {
            $transaction,
            purchase: {
              findFirst: vi.fn(async () => ({
                ...run,
                id: "purchase-1",
                status: "pending_approval",
                createdAt: new Date(0),
                nextPollAt: new Date(),
              })),
            },
          },
          paymentWallet: { describe: () => ({ id: "fake" }) },
        } as never,
        { purchaseId: "purchase-1" },
      ),
    ).rejects.toBe(failure);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });

  it("budgets a best-effort watch message before swallowing its write failure", async () => {
    const { $transaction } = transactionBoundary();
    await postRoutineWatchMessage({ prisma: { $transaction }, events: {} } as never, {
      ...run,
      role: "system",
      text: "A change was found",
    });
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });

  it("budgets publishing a run's final message", async () => {
    const { failure, $transaction } = transactionBoundary();
    await expect(
      publishMessage({ prisma: { $transaction } } as never, run, "bot", [
        { kind: "text", text: "Finished" },
      ]),
    ).rejects.toBe(failure);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });

  it("budgets an MCP connection and its approval card after local URL validation", async () => {
    const { failure, $transaction } = transactionBoundary();
    await expect(
      addMcpServerFromTool(
        { prisma: { $transaction }, secretStore: {}, mcpAllowPrivateEndpoint: true } as never,
        run,
        run.botId,
        { name: "Local fixture", transport: "streamable_http", endpoint: "http://127.0.0.1/mcp" },
        "operation-1",
      ),
    ).rejects.toBe(failure);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });

  it("budgets media completion and message publication", async () => {
    const { failure, $transaction } = transactionBoundary();
    const delivery = mediaDelivery(
      { prisma: { $transaction }, artifacts: {}, events: {} } as never,
      run,
      {
        providerId: "fake",
        operationId: "operation-1",
      },
    );
    await expect(
      delivery.publish({ kind: "text", text: "Ready" }, "job-1", "artifact-1"),
    ).rejects.toBe(failure);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });

  it("budgets expired media settlement through its recipient/wake callback", async () => {
    const { failure, $transaction } = transactionBoundary();
    vi.spyOn(mediaTools, "generateMediaFromTool").mockResolvedValue({
      error: "fixture poll unavailable",
    });
    const deps = {
      prisma: {
        $transaction,
        externalEffect: {
          findFirst: vi.fn(async () => ({
            id: "job-1",
            createdAt: new Date(0),
            request: { threadGeneration: 0 },
            run: { ...run, thread: { groupId: null } },
          })),
        },
        thread: { updateMany: vi.fn(async () => ({ count: 1 })) },
        spaceMember: { findUnique: vi.fn(async () => ({ id: "member-1" })) },
        bot: { findFirst: vi.fn(async () => ({ id: run.botId })) },
      },
      mediaGeneration: { id: "fake", capabilities: { video: true } },
      artifacts: {},
    };
    await expect(pollMediaVideo(deps as never, { jobId: "job-1" })).rejects.toBe(failure);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), budget);
  });
});
