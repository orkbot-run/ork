// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJobReconciler } from "@orkbot/adapters";
import {
  claimSteering,
  createBackgroundHelper,
  createThreadEvents,
  createThreadMessage,
  runAsSystem,
  runAsTenant,
} from "@orkbot/db";
import { describe, expect, it, vi } from "vitest";
import { createRunTrustLoaders } from "../../adapters/src/run-trust.js";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { allowFixtureAiDataSharing } from "./fixture-ai-consent.js";
import { sessionCookieHeader } from "./index.js";
import { startModelEmulator } from "./model-emulator.js";
import { asSystem } from "./system-db.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";

describe.skipIf(!enabled)("background helper product flow (PostgreSQL)", () => {
  it("starts a durable child through the Pi run_subagent tool", async () => {
    const model = await startModelEmulator({
      apiKey: "offline-helper-fixture-key",
      steps: [
        {
          expect(request) {
            expect(request.tools).toContainEqual(
              expect.objectContaining({
                function: expect.objectContaining({ name: "run_subagent" }),
              }),
            );
          },
          response: {
            type: "tool",
            id: "background-call",
            name: "run_subagent",
            arguments: { name: "Research", task: "Inspect the fixture", background: true },
          },
        },
        ...Array.from({ length: 8 }, () => ({
          expect() {},
          response: { type: "text" as const, text: "Fixture response." },
        })),
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "orkbot-pi-helper-"));
    let close: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("@orkbot/api/app");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: origin,
        webOrigin: origin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "pi",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        encryptionKey: "offline-model-fixture-encryption-key",
      });
      close = handles.stop;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `pi-helper-${randomUUID()}@orkbot.test`,
          password: "password12",
          name: "Fixture",
        }),
      });
      expect(signup.ok).toBe(true);
      const cookie = sessionCookieHeader(signup);
      const call = async <T>(procedure: string, body: unknown): Promise<T> => {
        const response = await handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: JSON.stringify({ json: body }),
        });
        expect(response.ok).toBe(true);
        return ((await response.json()) as { json: T }).json;
      };
      await call("models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: "offline-helper-fixture-key",
        contextWindow: 160_000,
        maxTokens: 4096,
      });
      const bot = await call<{ id: string }>("bots/create", {
        name: "Pi helper fixture",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);
      await call("bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
      await allowFixtureAiDataSharing(handles.app, cookie, { botId: bot.id });
      const parent = await call<{ runId: string }>("threads/send", {
        botId: bot.id,
        text: "Start a background helper for this fixture.",
      });
      const db = asSystem(handles.prisma);
      await expect
        .poll(
          async () => {
            const current = await db.run.findUniqueOrThrow({ where: { id: parent.runId } });
            if (current.status === "failed") throw new Error(`Parent failed: ${current.error}`);
            return db.thread.count({ where: { parentRunId: parent.runId } });
          },
          {
            timeout: 20_000,
            interval: 100,
          },
        )
        .toBe(1);
      const child = await db.thread.findFirstOrThrow({
        where: { parentRunId: parent.runId },
        include: { runs: true },
      });
      expect(child.runs).toHaveLength(1);
      expect(child.runs[0]).toMatchObject({ trigger: "tickets", requiredReaderVersion: 3 });
      await expect
        .poll(
          async () => (await db.run.findUniqueOrThrow({ where: { id: child.runs[0]!.id } })).status,
          { timeout: 20_000, interval: 100 },
        )
        .toBe("completed");
    } finally {
      await close?.();
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 45_000);

  it("executes a helper and returns its result to the parent; stop is scoped and idempotent", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "orkbot-helper-flow-"));
    let close: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("@orkbot/api/app");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: origin,
        webOrigin: origin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "scripted",
        wakeupDriver: "memory",
        defaultProvider: "scripted",
        defaultModel: "scripted",
        signupsEnabled: "true",
      });
      close = handles.stop;
      const signup = async () => {
        const response = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({
            email: `helper-${randomUUID()}@orkbot.test`,
            password: "password12",
            name: "Fixture",
          }),
        });
        expect(response.ok).toBe(true);
        return sessionCookieHeader(response);
      };
      const request = (cookie: string, procedure: string, body: unknown = {}) =>
        handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: JSON.stringify({ json: body }),
        });
      const call = async <T>(cookie: string, procedure: string, body: unknown = {}): Promise<T> => {
        const response = await request(cookie, procedure, body);
        expect(response.ok).toBe(true);
        return ((await response.json()) as { json: T }).json;
      };
      const owner = await signup();
      const stranger = await signup();
      const actor = await call<{ userId: string; spaceId: string }>(owner, "me");
      const bot = await call<{ id: string }>(owner, "bots/create", {
        name: "Helper owner",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, owner, bot.id);
      const otherBot = await call<{ id: string }>(owner, "bots/create", {
        name: "Other bot",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, owner, otherBot.id);
      const db = asSystem(handles.prisma);
      const thread = await db.thread.findUniqueOrThrow({ where: { botId: bot.id } });
      const base = {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: bot.id,
        threadId: thread.id,
      };
      const task = await db.task.create({
        data: { ...base, prompt: "Parent task", status: "running" },
      });
      const parent = await db.run.create({
        data: {
          ...base,
          taskId: task.id,
          status: "running",
          trigger: "user",
          leaseOwner: "parent-worker",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const computerId = (await db.bot.findUniqueOrThrow({ where: { id: bot.id } })).computerId;
      expect(computerId).toBeTruthy();
      await db.computerExecutionLease.upsert({
        where: { computerId_botId: { computerId: computerId!, botId: bot.id } },
        create: {
          computerId: computerId!,
          botId: bot.id,
          runId: parent.id,
          fence: 1,
          expiresAt: new Date(Date.now() + 60_000),
        },
        update: { runId: parent.id, fence: 1, expiresAt: new Date(Date.now() + 60_000) },
      });
      const create = (callId: string) =>
        runAsTenant(actor, () =>
          createBackgroundHelper(handles.prisma, {
            spaceId: actor.spaceId,
            parentThreadId: thread.id,
            parentRunId: parent.id,
            parentLease: { owner: "parent-worker", fence: 1 },
            callId,
            name: "Helper",
            task: "Summarize the fixture request",
          }),
        );
      const helper = await create("finish");
      const stopped = await create("stop");
      const interrupted = await create("interrupted");
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.run_reader_version', '3', true)`;
        await tx.run.updateMany({
          where: { id: { in: [stopped.runId, interrupted.runId] } },
          data: {
            status: "running",
            leaseOwner: "fixture-worker",
            leaseFence: 1,
            leaseExpiresAt: new Date(Date.now() + 60_000),
          },
        });
      });
      await runAsSystem("run helper in product fixture", () =>
        handles.executor.continueRun(helper.runId, "helper-worker"),
      );
      const finished = await db.run.findUniqueOrThrow({ where: { id: helper.runId } });
      expect(finished.status).toBe("completed");
      expect(
        await db.computerExecutionLease.findUniqueOrThrow({
          where: { computerId_botId: { computerId: computerId!, botId: bot.id } },
        }),
      ).toMatchObject({ runId: parent.id, fence: 1 });
      expect(finished.botOutcomeReturnedAt).not.toBeNull();
      const card = await db.message.findUniqueOrThrow({
        where: {
          threadId_clientNonce: {
            threadId: thread.id,
            clientNonce: `background-helper:${helper.runId}`,
          },
        },
      });
      expect(card.blocks).toMatchObject([
        {
          kind: "subagent",
          status: "completed",
          agentId: helper.runId,
          result: expect.any(String),
        },
      ]);
      expect(await db.steeringMessage.findMany({ where: { messageId: card.id } })).toMatchObject([
        { runId: parent.id, originTrigger: "helper_result" },
      ]);
      const claimed = await runAsTenant(actor, () =>
        claimSteering(handles.prisma, {
          threadId: thread.id,
          botId: bot.id,
          runId: parent.id,
          leaseOwner: "parent-worker",
          leaseFence: 1,
          seenIds: [],
        }),
      );
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({ origin: "helper" });
      const trust = createRunTrustLoaders(
        { prisma: handles.prisma } as Parameters<typeof createRunTrustLoaders>[0],
        {
          run: { ...actor, trigger: "user" },
          runId: parent.id,
          botId: bot.id,
          taskPrompt: "Parent task",
          ownerStartedRun: true,
          messagingChannelRun: false,
          sourceMessage: { role: "user", blocks: [{ kind: "text", text: "Parent task" }] },
          connectedPlugins: [],
        },
      );
      expect(await runAsTenant(actor, () => trust.receivedOutsideMessage())).toBe(true);
      expect(await trust.loadOwnerWords()).toBe("Parent task");

      expect(
        (await request(stranger, "threads/stopHelper", { botId: bot.id, agentId: stopped.runId }))
          .ok,
      ).toBe(false);
      expect(
        (await request(owner, "threads/stopHelper", { botId: otherBot.id, agentId: stopped.runId }))
          .ok,
      ).toBe(false);
      expect((await db.run.findUniqueOrThrow({ where: { id: stopped.runId } })).status).toBe(
        "running",
      );
      expect(
        await call(owner, "threads/stopHelper", { botId: bot.id, agentId: stopped.runId }),
      ).toEqual({ ok: true });
      expect(
        await call(owner, "threads/stopHelper", { botId: bot.id, agentId: stopped.runId }),
      ).toEqual({ ok: true });
      expect((await db.run.findUniqueOrThrow({ where: { id: stopped.runId } })).status).toBe(
        "cancelled",
      );
      expect((await db.run.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe("running");
      const stoppedCard = await db.message.findUniqueOrThrow({
        where: {
          threadId_clientNonce: {
            threadId: thread.id,
            clientNonce: `background-helper:${stopped.runId}`,
          },
        },
      });
      expect(stoppedCard.blocks).toMatchObject([{ status: "failed", stopped: true }]);
      expect(await db.event.count({ where: { threadId: thread.id, type: "run.cancelled" } })).toBe(
        0,
      );

      // A worker may die after committing its final message and status, before delivery.
      await runAsTenant(actor, () =>
        createThreadMessage(handles.prisma, {
          threadId: interrupted.threadId,
          runId: interrupted.runId,
          botId: bot.id,
          role: "bot",
          blocks: [{ kind: "text", text: "Recovered helper result." }],
        }),
      );
      await db.run.update({
        where: { id: interrupted.runId },
        data: { status: "completed", completedAt: new Date() },
      });
      const recovery = createJobReconciler({
        prisma: handles.prisma,
        events: createThreadEvents(handles.prisma),
        jobs: {
          enqueue: vi.fn(async () => undefined),
          cancel: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
        },
      });
      await runAsSystem("reconcile interrupted helper", () => recovery.reconcileOnce());
      await runAsSystem("repeat interrupted helper reconciliation", () => recovery.reconcileOnce());
      const recoveredCard = await db.message.findUniqueOrThrow({
        where: {
          threadId_clientNonce: {
            threadId: thread.id,
            clientNonce: `background-helper:${interrupted.runId}`,
          },
        },
      });
      expect(recoveredCard.blocks).toMatchObject([
        { status: "completed", result: "Recovered helper result." },
      ]);
      expect(
        await db.steeringMessage.findMany({ where: { messageId: recoveredCard.id } }),
      ).toMatchObject([{ runId: parent.id, originTrigger: "helper_result" }]);
      expect(
        (await db.run.findUniqueOrThrow({ where: { id: interrupted.runId } })).botOutcomeReturnedAt,
      ).not.toBeNull();
      await recovery.stop();
    } finally {
      await close?.();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
