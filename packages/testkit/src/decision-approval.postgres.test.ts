// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { createApp } from "@orkbot/api/app";
import type { MessageBlock } from "@orkbot/contracts";
import { answerRunInput, runAsSystem } from "@orkbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

const describeDb =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;
const origin = "http://127.0.0.1:5173";

describeDb("persisted decision approval rules", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let dataDir: string;
  let cookie: string;
  let botId: string;

  beforeAll(async () => {
    const { createApp } = await import("@orkbot/api/app");
    dataDir = await mkdtemp(path.join(tmpdir(), "orkbot-decision-approval-"));
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      authUrl: origin,
      webOrigin: origin,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
    });
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `decision-${randomUUID()}@orkbot.test`,
        password: "password12",
        name: "Decision fixture",
      }),
    });
    expect(signup.status).toBeLessThan(400);
    cookie = sessionCookieHeader(signup);
    const response = await handles.app.request("/rpc/bots/create", {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({
        json: {
          name: "Decision fixture",
          title: "",
          description: "",
          instructions: "",
          notifyOnFinish: false,
        },
      }),
    });
    expect(response.status).toBeLessThan(400);
    const result = (await response.json()) as { json: { id: string } };
    botId = result.json.id;
    await discardBotIntroRun(handles, cookie, botId);
  }, 30_000);

  afterAll(async () => {
    await handles?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it.each([
    { kind: "schedule_create", request: {}, metadata: {}, trigger: "user" },
    { kind: "schedule_update", request: {}, metadata: {}, trigger: "user" },
    {
      kind: "schedule_create",
      request: { watch: { kind: "command", command: "date" } },
      metadata: { allowRule: true },
      trigger: "user",
    },
    {
      kind: "destination.write",
      request: {},
      metadata: { approvalReason: "outside_content_schedule", allowRule: false },
      trigger: "user",
    },
    { kind: "destination.write", request: {}, metadata: {}, trigger: "webhook" },
  ])(
    "rejects legacy Always for $kind atomically but accepts Allow once",
    async ({ kind, request, metadata, trigger }) => {
      const db = asSystem(handles.prisma);
      const bot = await db.bot.findUniqueOrThrow({ where: { id: botId } });
      const thread = await db.thread.findUniqueOrThrow({ where: { botId } });
      const scope = { spaceId: bot.spaceId, botId, threadId: thread.id, userId: bot.userId };
      const task = await db.task.create({
        data: { ...scope, prompt: "Review the change", status: "running" },
      });
      const run = await db.run.create({
        data: { ...scope, taskId: task.id, status: "waiting_input", trigger },
      });
      const effect = await db.externalEffect.create({
        data: {
          spaceId: bot.spaceId,
          runId: run.id,
          kind,
          request,
          status: "intended",
          idempotencyKey: randomUUID(),
        },
      });
      const blocks = [
        {
          kind: "ask",
          text: "Review?",
          status: "pending",
          approvalEffectId: effect.id,
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "always", label: "Always allow" },
            { id: "deny", label: "Deny" },
          ],
          ...metadata,
        },
      ] as MessageBlock[];
      const message = await db.$transaction(async (tx) => {
        const updated = await tx.thread.update({
          where: { id: thread.id },
          data: { nextMessageSeq: { increment: 1 } },
        });
        return tx.message.create({
          data: {
            threadId: thread.id,
            seq: updated.nextMessageSeq - 1,
            runId: run.id,
            botId,
            role: "bot",
            blocks,
          },
        });
      });
      const answer = {
        spaceId: bot.spaceId,
        threadId: thread.id,
        runId: run.id,
        messageId: message.id,
        answeredByUserId: bot.userId,
      };
      const before = {
        run: await db.run.findUniqueOrThrow({ where: { id: run.id } }),
        effect: await db.externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
        message: await db.message.findUniqueOrThrow({ where: { id: message.id } }),
        task: await db.task.findUniqueOrThrow({ where: { id: task.id } }),
        rules: await db.userActionApprovalRule.findMany({ where: { userId: bot.userId } }),
        spaceRules: await db.actionApprovalRule.findMany({ where: { spaceId: bot.spaceId } }),
      };
      expect(
        await runAsSystem("reject stale approval rule", () =>
          answerRunInput(handles.prisma, { ...answer, answer: "always" }),
        ),
      ).toBe(false);
      expect(await db.run.findUniqueOrThrow({ where: { id: run.id } })).toEqual(before.run);
      expect(await db.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).toEqual(
        before.effect,
      );
      expect(await db.message.findUniqueOrThrow({ where: { id: message.id } })).toEqual(
        before.message,
      );
      expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(before.task);
      expect(await db.userActionApprovalRule.findMany({ where: { userId: bot.userId } })).toEqual(
        before.rules,
      );
      expect(await db.actionApprovalRule.findMany({ where: { spaceId: bot.spaceId } })).toEqual(
        before.spaceRules,
      );
      expect(
        await runAsSystem("approve one effect", () =>
          answerRunInput(handles.prisma, { ...answer, answer: "allow" }),
        ),
      ).toBe(true);
      expect(await db.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).toMatchObject(
        { status: "approved" },
      );
      expect(await db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "queued",
      });
      await db.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
    },
  );
});
