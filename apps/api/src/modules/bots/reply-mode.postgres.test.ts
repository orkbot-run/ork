// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { Actor } from "@orkbot/contracts";
import { toolEffectIdempotencyKey } from "@orkbot/core/node/approval-effect-key";
import type { Prisma, PrismaClient } from "@orkbot/db";
import {
  asSystem,
  createDb,
  declareRunReaderVersion,
  provisionMessagingIdentity,
  RunHistoryWriteError,
  runAsTenant,
} from "@orkbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordEffect } from "../../../../../packages/adapters/src/run-effects.js";

const url = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE && url ? describe.sequential : describe.skip;

postgres("immutable bot reply modes (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  beforeAll(() => {
    db = createDb(url!);
    system = asSystem(db.prisma);
  });
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  async function fixture(mode: "chat" | "explicit") {
    const identity = await provisionMessagingIdentity(
      system,
      { provider: "email", address: `reply-mode-${randomUUID()}@example.test` },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    const { spaceId, userId, botId, threadId } = identity;
    await system.bot.update({ where: { id: botId }, data: { replyMode: mode } });
    const actor: Actor = {
      spaceId,
      userId,
      email: "fixture@example.test",
      isDeploymentOwner: false,
    };
    const create = async (retryOfRunId?: string) =>
      runAsTenant(actor, async () => {
        const task = await db.prisma.task.create({
          data: { spaceId, userId, botId, threadId, prompt: "Fixture", status: "queued" },
        });
        // Intentionally omit both new columns, as a previous-release producer does.
        return db.prisma.run.create({
          data: {
            spaceId,
            userId,
            botId,
            threadId,
            taskId: task.id,
            trigger: "user",
            status: "queued",
            retryOfRunId,
          },
        });
      });
    const claim = (tx: Prisma.TransactionClient, id: string) =>
      tx.run.updateMany({
        where: { id, status: "queued" },
        data: { status: "leased", leaseOwner: "worker", leaseFence: { increment: 1 } },
      });
    return { identity, actor, create, claim, botId };
  }

  it("pins a legacy producer's explicit run and rejects readers zero and one", async () => {
    const f = await fixture("explicit");
    const run = await f.create();
    expect(run).toMatchObject({ replyMode: "explicit", requiredReaderVersion: 2 });
    await runAsTenant(f.actor, async () => {
      expect(await f.claim(db.prisma, run.id)).toEqual({ count: 0 });
      expect(
        await db.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.run_reader_version', '1', true)`;
          return f.claim(tx, run.id);
        }),
      ).toEqual({ count: 0 });
      expect(
        await db.prisma.$transaction(async (tx) => {
          await declareRunReaderVersion(tx);
          return f.claim(tx, run.id);
        }),
      ).toEqual({ count: 1 });
    });
  });

  it("retains chat and file-reader-one compatibility", async () => {
    const f = await fixture("chat");
    const chat = await f.create();
    const files = await f.create();
    expect(chat).toMatchObject({ replyMode: "chat", requiredReaderVersion: 0 });
    await runAsTenant(f.actor, async () => {
      expect(await f.claim(db.prisma, chat.id)).toEqual({ count: 1 });
      await db.prisma.run.update({ where: { id: files.id }, data: { requiredReaderVersion: 1 } });
      expect(
        await db.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.run_reader_version', '1', true)`;
          return f.claim(tx, files.id);
        }),
      ).toEqual({ count: 1 });
    });
  });

  it.each(["chat", "explicit"] as const)(
    "keeps %s across a setting change, pause, requeue and retry",
    async (mode) => {
      const f = await fixture(mode);
      const original = await f.create();
      const opposite = mode === "chat" ? "explicit" : "chat";
      await system.bot.update({ where: { id: f.botId }, data: { replyMode: opposite } });
      await system.run.update({ where: { id: original.id }, data: { status: "waiting_input" } });
      await system.run.update({
        where: { id: original.id },
        data: { status: "queued", replyMode: opposite, requiredReaderVersion: 0 },
      });
      expect(await system.run.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
        replyMode: mode,
        requiredReaderVersion: mode === "explicit" ? 2 : 0,
      });
      expect(await f.create(original.id)).toMatchObject({ replyMode: mode });
      expect(await f.create()).toMatchObject({ replyMode: opposite });
    },
  );

  it("allows file effects on an explicit source without lowering its protocol", async () => {
    const f = await fixture("explicit");
    const source = await f.create();
    await runAsTenant(f.actor, async () => {
      await db.prisma.$transaction(async (tx) => {
        await declareRunReaderVersion(tx);
        await f.claim(tx, source.id);
      });
      await db.prisma.run.update({ where: { id: source.id }, data: { status: "running" } });
      const deps = { prisma: db.prisma, runLease: { runId: source.id, owner: "worker", fence: 1 } };
      const key = toolEffectIdempotencyKey(source.id, "message_bot", { files: ["report.txt"] }, 0);
      expect(
        await recordEffect(
          deps as never,
          source,
          "message_bot",
          key,
          { files: ["report.txt"] },
          undefined,
          undefined,
          undefined,
          true,
        ),
      ).toMatchObject({ duplicate: false });
      expect(await db.prisma.run.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({
        replyMode: "explicit",
        requiredReaderVersion: 2,
      });
      await expect(
        recordEffect(
          { ...deps, runLease: { ...deps.runLease, fence: 0 } } as never,
          source,
          "message_bot",
          toolEffectIdempotencyKey(source.id, "message_bot", { files: ["report.txt"] }, 1),
          { files: ["report.txt"] },
          undefined,
          undefined,
          undefined,
          true,
        ),
      ).rejects.toBeInstanceOf(RunHistoryWriteError);
    });
  });

  it("does not read another owner's bot or use a foreign retry source", async () => {
    const first = await fixture("explicit");
    const second = await fixture("chat");
    const source = await first.create();
    await expect(second.create(source.id)).rejects.toThrow("Retry source is unavailable");
    await runAsTenant(second.actor, async () => {
      expect(await db.prisma.bot.findUnique({ where: { id: first.botId } })).toBeNull();
      const own = await second.create();
      const { id: _id, ...values } = own;
      await expect(
        db.prisma.run.create({ data: { ...values, botId: first.botId } }),
      ).rejects.toThrow("Bot is unavailable");
    });
  });
});
