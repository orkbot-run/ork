// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { randomBytes } from "node:crypto";
import type { McpFormRequest, MessageBlock } from "@orkbot/contracts";
import {
  answerMcpForm,
  asSystem,
  closeMcpForm,
  createDb,
  createThreadEvents,
  LocalKeyProvider,
  McpFormAnswerError,
  openMcpForm,
  parseMcpFormAnswer,
  provisionMessagingIdentity,
  readMcpFormAnswer,
  reconcileMcpForms,
  runAsSystem,
  runAsTenant,
} from "@orkbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import { askMcpForm } from "./run-mcp-form.js";

const url = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE && url ? describe.sequential : describe.skip;

postgres("MCP forms across worker and API replicas", () => {
  const address = `+1556${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  const provider = "sendblue";
  const key = { id: "test-mcp-forms", key: randomBytes(32) };
  let worker: ReturnType<typeof createDb>;
  let api: ReturnType<typeof createDb>;
  let scope: { botId: string; spaceId: string; userId: string; threadId: string };
  const request: McpFormRequest = {
    integrationName: "Project tools",
    message: "Which project should be opened?",
    fields: [
      { name: "project", type: "string", required: true, minLength: 2 },
      { name: "shared", type: "boolean", required: false },
    ],
  };

  beforeAll(async () => {
    const client = () =>
      createDb(url!, { encryptContent: true, keyProvider: new LocalKeyProvider([key]) });
    worker = client();
    api = client();
    const owner = await runAsSystem("MCP form fixture", () =>
      provisionMessagingIdentity(
        worker.prisma,
        { provider, address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const thread = await asSystem(worker.prisma).thread.findUniqueOrThrow({
      where: { botId: owner.botId },
    });
    scope = {
      userId: owner.userId,
      botId: owner.botId,
      spaceId: owner.spaceId,
      threadId: thread.id,
    };
  });

  afterAll(async () => {
    if (scope) {
      const system = asSystem(worker.prisma);
      await system.messagingIdentity.deleteMany({ where: { provider, address } });
      await system.organization.deleteMany({ where: { id: scope.spaceId } });
      await system.user.deleteMany({ where: { id: scope.userId } });
    }
    for (const client of [worker, api].filter(Boolean)) {
      await client.prisma.$disconnect();
      await client.pool.end();
    }
  });

  async function lease() {
    const system = asSystem(worker.prisma);
    const task = await system.task.create({
      data: { ...scope, prompt: "Open a project", status: "running" },
    });
    const leaseOwner = "worker-form-1";
    const leaseFence = 31;
    const run = await system.run.create({
      data: {
        ...scope,
        taskId: task.id,
        trigger: "user",
        status: "running",
        leaseOwner,
        leaseFence,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    return { ...scope, runId: run.id, leaseOwner, leaseFence };
  }

  async function textCard(id: string) {
    const row = await asSystem(api.prisma).message.findUniqueOrThrow({ where: { id } });
    return (row.blocks as MessageBlock[])[0];
  }

  it("validates and consumes an owner response privately, with an atomic answer even under duplicates", async () => {
    const turn = await lease();
    const open = await runAsTenant(scope, () => openMcpForm(worker.prisma, turn, request));
    expect(open).toBeDefined();
    const { id, messageId } = open!;
    const answer = (payload: unknown, userId = scope.userId) =>
      answerMcpForm(api.prisma, {
        ...turn,
        userId,
        messageId,
        answer: parseMcpFormAnswer(JSON.stringify({ mcpFormId: id, ...(payload as object) }))!,
      });
    await expect(
      runAsSystem("wrong caller", () => answer({ action: "decline" }, "other-user")),
    ).resolves.toBeUndefined();
    await expect(
      runAsTenant(scope, () => answer({ action: "accept", content: { shared: false } })),
    ).rejects.toBeInstanceOf(McpFormAnswerError);
    const response = {
      action: "accept",
      content: { project: "Example-915-private", shared: false },
    };
    const answers = await runAsTenant(scope, () =>
      Promise.all([answer(response), answer(response)]),
    );
    expect(answers.filter((seq) => seq !== undefined)).toHaveLength(1);
    const dbRow = await asSystem(worker.prisma).externalEffect.findUniqueOrThrow({ where: { id } });
    expect(dbRow.result).toMatch(/^rkz1:/);
    expect(dbRow.result).not.toContain("Example-915-private");
    expect(await textCard(messageId)).toMatchObject({
      kind: "ask",
      status: "answered",
      answer: "accepted",
      mcpForm: { status: "accepted" },
    });
    const screenEvents = await asSystem(api.prisma).event.findMany({
      where: { runId: turn.runId },
    });
    expect(JSON.stringify(screenEvents)).not.toContain("Example-915-private");
    await expect(
      runAsTenant(scope, () => readMcpFormAnswer(worker.prisma, turn, id)),
    ).resolves.toEqual(response);
    await runAsTenant(scope, () => closeMcpForm(worker.prisma, { ...turn, id, messageId }));
    expect(await asSystem(api.prisma).externalEffect.findUnique({ where: { id } })).toBeNull();
  });

  it.each(["decline", "cancel"] as const)(
    "delivers %s over the thread feed to the process holding the live call",
    async (action) => {
      const turn = await lease();
      const abort = new AbortController();
      const events = createThreadEvents(worker.prisma, undefined, { catchUpMs: 15 });
      const context = {
        deps: { prisma: worker.prisma, events },
        bot: { id: turn.botId },
        thread: { id: turn.threadId },
        run: { id: turn.runId, userId: turn.userId, spaceId: turn.spaceId },
        workerId: turn.leaseOwner,
        fence: turn.leaseFence,
        context: { signal: abort.signal },
        source: { ownerStartedRun: true },
      } as unknown as RunContext;
      const reply = runAsTenant(scope, () => askMcpForm(context, request, abort.signal));
      try {
        let prompt: { id: string; messageId: string } | undefined;
        await vi.waitFor(async () => {
          const message = await asSystem(api.prisma).message.findFirst({
            where: { runId: turn.runId, role: "bot" },
          });
          const first = (message?.blocks as MessageBlock[] | undefined)?.[0];
          if (message && first?.kind === "ask" && first.mcpForm)
            prompt = { id: first.mcpForm.id, messageId: message.id };
          expect(prompt).toBeDefined();
        });
        const { id, messageId } = prompt!;
        await runAsTenant(scope, () =>
          answerMcpForm(api.prisma, {
            ...turn,
            messageId,
            answer: { mcpFormId: id, action },
          }),
        );
        await expect(reply).resolves.toEqual({ action });
        expect(await asSystem(api.prisma).externalEffect.findUnique({ where: { id } })).toBeNull();
      } finally {
        abort.abort();
        await reply.catch(() => undefined);
      }
    },
  );

  it("expires an abandoned form after its worker lease times out", async () => {
    const turn = await lease();
    const { id, messageId } = (await runAsTenant(scope, () =>
      openMcpForm(worker.prisma, turn, request),
    ))!;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      await expect(
        runAsTenant(scope, () =>
          answerMcpForm(api.prisma, {
            ...turn,
            messageId,
            answer: { mcpFormId: id, action: "cancel" },
          }),
        ),
      ).resolves.toBeUndefined();
      const notify = vi.fn(async () => undefined);
      await runAsSystem("reconcile abandoned MCP form", () =>
        reconcileMcpForms(api.prisma, notify),
      );
      expect(notify).toHaveBeenCalledOnce();
      expect(await textCard(messageId)).toMatchObject({
        status: "answered",
        mcpForm: { status: "expired" },
      });
      expect(await asSystem(api.prisma).externalEffect.findUnique({ where: { id } })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
