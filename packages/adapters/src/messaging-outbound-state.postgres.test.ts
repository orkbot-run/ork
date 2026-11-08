// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { MessagingSurface } from "@orkbot/adapter-kit";
import type { Prisma, PrismaClient } from "@orkbot/db";
import {
  asSystem,
  createDb,
  createPool,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@orkbot/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverMessagingOutbound } from "./messaging-delivery.js";
import {
  declareDirectDelivery,
  declareRejectedDelivery,
  listUnknownDirectDeliveries,
  resolveUnknownDirectDelivery,
} from "./messaging-outbound-state.js";

const url = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE && url ? describe.sequential : describe.skip;

postgres("protected direct delivery outcomes (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let owner: { userId: string; spaceId: string; botId: string; threadId: string };
  let identityId: string;
  let sourceMessageId: string;
  beforeAll(() => {
    db = createDb(url!);
    system = asSystem(db.prisma);
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  async function provision() {
    const result = await provisionMessagingIdentity(
      system,
      { provider: "telegram", address: `outcome-${randomUUID()}` },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    const identity = await system.messagingIdentity.findUniqueOrThrow({
      where: { botId: result.botId },
    });
    await system.messagingIdentity.update({
      where: { id: identity.id },
      data: { dmThreadId: `fixture:${identity.id}` },
    });
    const { userId, spaceId, botId, threadId } = result;
    return { owner: { userId, spaceId, botId, threadId }, identityId: identity.id };
  }
  beforeEach(async () => {
    ({ owner, identityId } = await provision());
    await system.messagingOutbound.deleteMany({});
    sourceMessageId = (
      await system.message.create({
        data: {
          threadId: owner.threadId,
          botId: owner.botId,
          role: "bot",
          seq: 900,
          blocks: [{ kind: "text", text: "Delivery fixture" }],
        },
      })
    ).id;
  });
  const row = (
    version = 1,
    identity = identityId,
    data: Partial<Prisma.MessagingOutboundCreateInput> = {},
  ) =>
    system.messagingOutbound.create({
      data: {
        kind: "dm",
        identityId: identity,
        idempotencyKey: `outcome:${randomUUID()}`,
        body: "Delivery fixture",
        sourceMessageId,
        requiredDeliveryVersion: version,
        ...data,
      },
    });
  const claim = (tx: Prisma.TransactionClient | PrismaClient, id: string) =>
    tx.messagingOutbound.updateMany({ where: { id, status: "pending" }, data: { status: "sent" } });
  const newClaim = (id: string) =>
    system.$transaction(async (tx) => {
      await declareDirectDelivery(tx);
      return claim(tx, id);
    });
  const review = () =>
    runAsTenant(owner, () => listUnknownDirectDeliveries(db.prisma, owner, identityId));
  async function unknown() {
    const target = await row();
    expect(await newClaim(target.id)).toEqual({ count: 1 });
    await system.messagingOutbound.updateMany({
      where: { id: target.id },
      data: { status: "pending", attempts: 1 },
    });
    expect(
      (await system.messagingOutbound.findUniqueOrThrow({ where: { id: target.id } })).status,
    ).toBe("uncertain");
    return target;
  }

  async function retargetToAnotherSpace() {
    const previousSpace = await system.space.findUniqueOrThrow({ where: { id: owner.spaceId } });
    const space = await system.space.create({
      data: {
        id: randomUUID(),
        name: "Another fixture Space",
        organizationId: previousSpace.organizationId,
        createdByUserId: owner.userId,
      },
    });
    await system.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: space.id, userId: owner.userId } },
      create: {
        id: randomUUID(),
        organizationId: space.organizationId,
        spaceId: space.id,
        userId: owner.userId,
        role: "owner",
        createdAt: new Date(),
      },
      update: {},
    });
    const bot = await system.bot.create({
      data: { spaceId: space.id, userId: owner.userId, name: "Current fixture bot", color: "blue" },
    });
    const thread = await system.thread.create({
      data: { spaceId: space.id, userId: owner.userId, botId: bot.id },
    });
    await system.messagingIdentity.update({
      where: { id: identityId },
      data: { spaceId: space.id, botId: bot.id },
    });
    await system.spaceMember.deleteMany({
      where: { spaceId: owner.spaceId, userId: owner.userId },
    });
    return { ...owner, spaceId: space.id, botId: bot.id, threadId: thread.id };
  }

  it("keeps old ordinary claims working while requiring the new protocol only for protected rows", async () => {
    const legacy = await row(0);
    expect(await claim(system, legacy.id)).toEqual({ count: 1 });
    await system.messagingOutbound.update({
      where: { id: legacy.id },
      data: { providerHandle: "known-legacy" },
    });
    const protectedRow = await row();
    expect(await claim(system, protectedRow.id)).toEqual({ count: 0 });
    expect(await newClaim(protectedRow.id)).toEqual({ count: 1 });
    const later = await row(0);
    expect(await claim(system, later.id)).toEqual({ count: 0 });
    expect(await newClaim(later.id)).toEqual({ count: 0 });
    const elsewhere = await provision();
    const elsewhereSource = await system.message.create({
      data: {
        threadId: elsewhere.owner.threadId,
        botId: elsewhere.owner.botId,
        role: "bot",
        seq: 900,
        blocks: [{ kind: "text", text: "Independent source" }],
      },
    });
    const other = await row(0, elsewhere.identityId, { sourceMessageId: elsewhereSource.id });
    expect(await claim(system, other.id)).toEqual({ count: 1 });
    const group = await row(0, identityId, {
      kind: "group",
      identityId: null,
      threadId: `group:${randomUUID()}`,
    });
    expect(await claim(system, group.id)).toEqual({ count: 1 });
  });

  it.each(["pending", "failed"])(
    "quarantines a legacy writer's unclassified protected %s result",
    async (status) => {
      const target = await row();
      await newClaim(target.id);
      await system.messagingOutbound.update({
        where: { id: target.id },
        data: { status, attempts: 5 },
      });
      expect(
        await system.messagingOutbound.findUniqueOrThrow({ where: { id: target.id } }),
      ).toMatchObject({ status: "uncertain", requiredDeliveryVersion: 1 });
      const later = await row(0);
      await system.messagingOutbound.update({
        where: { id: target.id },
        data: { updatedAt: new Date(0) },
      });
      expect(await claim(system, later.id)).toEqual({ count: 0 });
      expect((await review()).items.map((item) => item.id)).toEqual([target.id]);
    },
  );

  it("retries confirmed rejection without leaking transaction-local declarations", async () => {
    const target = await row();
    await newClaim(target.id);
    await system.$transaction(async (tx) => {
      await declareRejectedDelivery(tx);
      expect(
        await tx.messagingOutbound.updateMany({
          where: { id: target.id, status: "sent" },
          data: { status: "pending" },
        }),
      ).toEqual({ count: 1 });
    });
    expect(await claim(system, target.id)).toEqual({ count: 0 });
    expect(await newClaim(target.id)).toEqual({ count: 1 });
    await system.messagingOutbound.update({ where: { id: target.id }, data: { status: "failed" } });
    expect(
      (await system.messagingOutbound.findUniqueOrThrow({ where: { id: target.id } })).status,
    ).toBe("uncertain");
    await runAsSystem("delivery local-setting proof", async () => {
      const connection = await db.pool.connect();
      try {
        for (const ending of ["COMMIT", "ROLLBACK"]) {
          await connection.query("BEGIN");
          await connection.query(
            "SELECT set_config('app.messaging_delivery_version','1',true), set_config('app.messaging_delivery_outcome','rejected',true)",
          );
          await connection.query(ending);
          const state = await connection.query(
            "SELECT current_setting('app.messaging_delivery_version',true) AS version, current_setting('app.messaging_delivery_outcome',true) AS outcome",
          );
          expect(state.rows[0]).toEqual({ version: "", outcome: "" });
        }
      } finally {
        connection.release();
      }
    });
  });

  it.each(["confirmed_sent", "confirmed_not_sent"] as const)(
    "resolves %s without resend and refuses every late legacy reopen",
    async (resolution) => {
      const target = await unknown();
      const listed = await review();
      const input = {
        identityId,
        outboundId: target.id,
        version: listed.items[0]!.version,
        resolution,
      };
      await expect(
        system.messagingOutbound.updateMany({
          where: { id: target.id },
          data: { status: "resolved_sent" },
        }),
      ).resolves.toEqual({ count: 0 });
      await expect(
        runAsTenant({ ...owner, userId: "foreign-user" }, () =>
          resolveUnknownDirectDelivery(db.prisma, { ...owner, userId: "foreign-user" }, input),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        runAsTenant(owner, () =>
          resolveUnknownDirectDelivery(db.prisma, owner, { ...input, version: "0".repeat(64) }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(
        await runAsTenant(owner, () => resolveUnknownDirectDelivery(db.prisma, owner, input)),
      ).toEqual({ changed: true });
      expect(
        await runAsTenant(owner, () => resolveUnknownDirectDelivery(db.prisma, owner, input)),
      ).toEqual({ changed: false });
      for (const status of ["pending", "failed", "sent", "uncertain"]) {
        expect(
          await system.messagingOutbound.updateMany({ where: { id: target.id }, data: { status } }),
        ).toEqual({ count: 0 });
      }
      const lateHandle = await system.messagingOutbound.update({
        where: { id: target.id },
        data: { providerHandle: "late-accepted-handle" },
      });
      expect(lateHandle.status).toBe(
        resolution === "confirmed_sent" ? "resolved_sent" : "resolved_not_sent",
      );
      const later = await row(0);
      expect(await claim(system, later.id)).toEqual({ count: 1 });
    },
  );

  it("does not resolve a review captured before an identity retarget", async () => {
    const target = await unknown();
    const old = (await review()).items[0]!;
    const replacement = await system.bot.create({
      data: { userId: owner.userId, spaceId: owner.spaceId, name: "Replacement", color: "blue" },
    });
    await system.messagingIdentity.update({
      where: { id: identityId },
      data: { botId: replacement.id },
    });
    expect(
      await runAsTenant(owner, () =>
        resolveUnknownDirectDelivery(db.prisma, owner, {
          identityId,
          outboundId: target.id,
          version: old.version,
          resolution: "confirmed_sent",
        }),
      ),
    ).toEqual({ changed: false });
    expect(
      (await system.messagingOutbound.findUniqueOrThrow({ where: { id: target.id } })).status,
    ).toBe("retired");
    expect((await review()).items).toEqual([]);
  });

  it.each(["confirmed_sent", "confirmed_not_sent"] as const)(
    "refuses stale file notices after %s and protects a known failure notice",
    async (resolution) => {
      const parent = await row(1, identityId, {
        idempotencyKey: `msg:${randomUUID()}:file:${randomUUID()}`,
      });
      await newClaim(parent.id);
      await system.messagingOutbound.updateMany({
        where: { id: parent.id },
        data: { status: "failed" },
      });
      const notice = () =>
        system.messagingOutbound.createMany({
          data: [
            {
              kind: "dm",
              identityId,
              idempotencyKey: `${parent.idempotencyKey}:notice`,
              body: "File was not sent",
            },
          ],
          skipDuplicates: true,
        });
      expect(await notice()).toEqual({ count: 0 });
      const item = (await review()).items[0]!;
      await runAsTenant(owner, () =>
        resolveUnknownDirectDelivery(db.prisma, owner, {
          identityId,
          outboundId: parent.id,
          version: item.version,
          resolution,
        }),
      );
      expect(await notice()).toEqual({ count: 0 });
      const rejected = await row(1, identityId, {
        idempotencyKey: `msg:${randomUUID()}:file:${randomUUID()}`,
      });
      await newClaim(rejected.id);
      await system.$transaction(async (tx) => {
        await declareRejectedDelivery(tx);
        await tx.messagingOutbound.updateMany({
          where: { id: rejected.id },
          data: { status: "failed" },
        });
      });
      const key = `${rejected.idempotencyKey}:notice`;
      expect(
        await system.messagingOutbound.createMany({
          data: [
            {
              kind: "dm",
              identityId,
              idempotencyKey: key,
              body: "File was not sent",
            },
          ],
        }),
      ).toEqual({ count: 1 });
      const guarded = await system.messagingOutbound.findUniqueOrThrow({
        where: { idempotencyKey: key },
      });
      expect(guarded.requiredDeliveryVersion).toBe(1);
      expect(await claim(system, guarded.id)).toEqual({ count: 0 });
      expect(await newClaim(guarded.id)).toEqual({ count: 1 });
    },
  );

  it("requires current ownership, Space membership and an active linked bot for review and recovery", async () => {
    const target = await unknown();
    const item = (await review()).items[0]!;
    const input = {
      identityId,
      outboundId: target.id,
      version: item.version,
      resolution: "confirmed_not_sent" as const,
    };
    const foreign = await provision();
    await expect(
      runAsTenant(foreign.owner, () =>
        listUnknownDirectDeliveries(db.prisma, foreign.owner, identityId),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      runAsTenant({ ...owner, spaceId: foreign.owner.spaceId }, () =>
        resolveUnknownDirectDelivery(
          db.prisma,
          { ...owner, spaceId: foreign.owner.spaceId },
          input,
        ),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await system.bot.update({ where: { id: owner.botId }, data: { archivedAt: new Date() } });
    await expect(review()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      runAsTenant(owner, () => resolveUnknownDirectDelivery(db.prisma, owner, input)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await system.bot.update({ where: { id: owner.botId }, data: { archivedAt: null } });
    await system.spaceMember.deleteMany({
      where: { userId: owner.userId, spaceId: owner.spaceId },
    });
    await expect(review()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  function surface() {
    const sendToThread = vi.fn<MessagingSurface["sendToThread"]>(async () => ({
      handle: `accepted:${randomUUID()}`,
    }));
    const messaging: MessagingSurface = {
      describe: () => ({
        id: "fixture",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { providers: [] },
      }),
      platforms: () => [],
      handleWebhook: () => null,
      onInbound: () => undefined,
      sendToThread,
      openDirectThread: async () => "fixture:dm",
      acknowledge: async () => undefined,
    };
    return { messaging, sendToThread };
  }
  const context = {
    spaceId: "",
    userId: "",
    operationId: "delivery-proof",
    traceId: "delivery-proof",
    signal: new AbortController().signal,
  };
  function deliveryDeps(messaging: MessagingSurface) {
    return {
      prisma: system,
      messaging,
      events: { sendUserMessage: vi.fn(), notify: vi.fn() },
      jobs: { enqueue: vi.fn() },
      artifacts: { get: vi.fn() },
    };
  }

  it("never duplicates an accepted-but-lost response and lets another identity finish while this lane waits", async () => {
    const first = await row(1, identityId, { body: "accepted remotely", createdAt: new Date(1) });
    await row(1, identityId, { body: "later", createdAt: new Date(2) });
    const other = await provision();
    const otherSource = await system.message.create({
      data: {
        threadId: other.owner.threadId,
        botId: other.owner.botId,
        role: "bot",
        seq: 900,
        blocks: [{ kind: "text", text: "Elsewhere" }],
      },
    });
    await row(1, other.identityId, {
      sourceMessageId: otherSource.id,
      body: "elsewhere",
      createdAt: new Date(3),
    });
    const { messaging, sendToThread } = surface();
    const remote: string[] = [];
    sendToThread.mockImplementation(async (request) => {
      remote.push(request.body);
      if (request.body === "accepted remotely") throw new Error("response lost");
      return { handle: `accepted:${request.body}` };
    });
    const deps = deliveryDeps(messaging);
    await deliverMessagingOutbound(deps, {}, context);
    await deliverMessagingOutbound(deps, {}, context);
    expect(remote.filter((body) => body === "accepted remotely")).toHaveLength(1);
    expect(remote).toContain("elsewhere");
    expect(remote).not.toContain("later");
    const item = (await review()).items[0]!;
    await runAsTenant(owner, () =>
      resolveUnknownDirectDelivery(db.prisma, owner, {
        identityId,
        outboundId: first.id,
        version: item.version,
        resolution: "confirmed_not_sent",
      }),
    );
    await deliverMessagingOutbound(deps, {}, context);
    expect(remote.filter((body) => body === "accepted remotely")).toHaveLength(1);
    expect(remote.filter((body) => body === "later")).toHaveLength(1);
  });

  it("quarantines a stale legacy no-handle crash before new protected traffic can pass", async () => {
    const stale = await row(0, identityId, {
      status: "sent",
      providerHandle: null,
      updatedAt: new Date(0),
      createdAt: new Date(1),
    });
    await row(1, identityId, { body: "later", createdAt: new Date(2) });
    const { messaging, sendToThread } = surface();
    await deliverMessagingOutbound(deliveryDeps(messaging), {}, context);
    expect(sendToThread).not.toHaveBeenCalled();
    expect(
      await system.messagingOutbound.findUniqueOrThrow({ where: { id: stale.id } }),
    ).toMatchObject({ status: "uncertain", requiredDeliveryVersion: 1 });
    expect(
      await system.messagingOutbound.updateMany({
        where: { id: stale.id },
        data: { status: "pending" },
      }),
    ).toEqual({ count: 0 });
    expect((await review()).items[0]!.id).toBe(stale.id);
  });

  it("promotes a legacy pending direct row before a new sender can create an unknown outcome", async () => {
    const original = await row(0);
    const { messaging, sendToThread } = surface();
    sendToThread.mockRejectedValue(new Error("accepted response lost"));
    await deliverMessagingOutbound(deliveryDeps(messaging), {}, context);
    await deliverMessagingOutbound(deliveryDeps(messaging), {}, context);
    expect(sendToThread).toHaveBeenCalledOnce();
    expect(
      await system.messagingOutbound.findUniqueOrThrow({ where: { id: original.id } }),
    ).toMatchObject({ status: "uncertain", requiredDeliveryVersion: 1 });
  });

  it("retires unavailable source history after retarget without previewing or sending its pending tail", async () => {
    const head = await unknown();
    const oldReview = (await review()).items[0]!;
    const tail = await row(1, identityId, { body: "Private old Space tail" });
    const current = await retargetToAnotherSpace();
    const nextSource = await system.message.create({
      data: {
        threadId: current.threadId,
        botId: current.botId,
        role: "bot",
        seq: 900,
        blocks: [{ kind: "text", text: "Current Space reply" }],
      },
    });
    await row(1, identityId, { sourceMessageId: nextSource.id, body: "Current Space reply" });
    const list = await runAsTenant(current, () =>
      listUnknownDirectDeliveries(db.prisma, current, identityId),
    );
    expect(list).toEqual({ items: [], hasMore: false, retiredCount: 1 });
    await expect(
      runAsTenant(current, () =>
        resolveUnknownDirectDelivery(db.prisma, current, {
          identityId,
          outboundId: head.id,
          version: oldReview.version,
          resolution: "confirmed_sent",
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const { messaging, sendToThread } = surface();
    await deliverMessagingOutbound(deliveryDeps(messaging), {}, context);
    expect(sendToThread.mock.calls.map(([request]) => request.body)).toEqual([
      "Current Space reply",
    ]);
    for (const id of [head.id, tail.id]) {
      expect((await system.messagingOutbound.findUniqueOrThrow({ where: { id } })).status).toBe(
        "retired",
      );
      expect(
        await system.messagingOutbound.updateMany({ where: { id }, data: { status: "pending" } }),
      ).toEqual({ count: 0 });
    }
  });

  it("rechecks the live source after artifact preparation before starting the external POST", async () => {
    const artifact = await system.artifact.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: owner.botId,
        name: "fixture.txt",
        mimeType: "text/plain",
        size: 1,
        hash: "fixture",
        storageKey: `fixture:${randomUUID()}`,
      },
    });
    const pending = await row(1, identityId, {
      idempotencyKey: `msg:${sourceMessageId}:file:${artifact.id}`,
      body: "",
    });
    const { messaging, sendToThread } = surface();
    const deps = deliveryDeps(messaging);
    deps.artifacts.get.mockImplementation(async () => {
      await retargetToAnotherSpace();
      return new Uint8Array([1]);
    });
    await deliverMessagingOutbound(deps, {}, context);
    expect(deps.artifacts.get).toHaveBeenCalledOnce();
    expect(sendToThread).not.toHaveBeenCalled();
    expect(
      (await system.messagingOutbound.findUniqueOrThrow({ where: { id: pending.id } })).status,
    ).toBe("retired");
  });

  it("protects a legacy final mirror tail of the same actual run, including after retarget", async () => {
    const task = await system.task.create({
      data: { ...owner, prompt: "Rolling mirror fixture", status: "running" },
    });
    const run = await system.run.create({
      data: { ...owner, taskId: task.id, trigger: "messaging", status: "running" },
    });
    await system.message.update({ where: { id: sourceMessageId }, data: { runId: run.id } });
    const prefix = await row(1);
    expect(await newClaim(prefix.id)).toEqual({ count: 1 });
    await system.messagingOutbound.update({
      where: { id: prefix.id },
      data: { providerHandle: "accepted-prefix" },
    });
    const source = async (seq: number, runId = run.id) =>
      system.message.create({
        data: {
          threadId: owner.threadId,
          botId: owner.botId,
          role: "bot",
          seq,
          runId,
          blocks: [{ kind: "text", text: "Legacy final tail" }],
        },
      });
    const tailSource = await source(901);
    const tail = await row(0, identityId, { sourceMessageId: tailSource.id });
    expect(tail.requiredDeliveryVersion).toBe(1);
    expect(await claim(system, tail.id)).toEqual({ count: 0 });
    const independentTask = await system.task.create({
      data: { ...owner, prompt: "Other run fixture", status: "running" },
    });
    const independentRun = await system.run.create({
      data: { ...owner, taskId: independentTask.id, trigger: "messaging", status: "running" },
    });
    const independentSource = await source(902, independentRun.id);
    expect(
      (await row(0, identityId, { sourceMessageId: independentSource.id })).requiredDeliveryVersion,
    ).toBe(0);
    const elsewhere = await provision();
    expect(
      (await row(0, elsewhere.identityId, { sourceMessageId: tailSource.id }))
        .requiredDeliveryVersion,
    ).toBe(0);
    await retargetToAnotherSpace();
    const obsoleteSource = await source(903);
    const obsolete = await row(0, identityId, { sourceMessageId: obsoleteSource.id });
    expect(obsolete.requiredDeliveryVersion).toBe(1);
    expect(await claim(system, obsolete.id)).toEqual({ count: 0 });
    const { messaging, sendToThread } = surface();
    await deliverMessagingOutbound(deliveryDeps(messaging), {}, context);
    expect(sendToThread).not.toHaveBeenCalled();
    expect(
      (await system.messagingOutbound.findUniqueOrThrow({ where: { id: obsolete.id } })).status,
    ).toBe("retired");
  });

  it("pins legacy system producers at INSERT and refuses arbitrary source-less content", async () => {
    const legacy = await row(0, identityId, {
      sourceMessageId: null,
      idempotencyKey: "link:legacy-producer-safe",
    });
    expect(await claim(system, legacy.id)).toEqual({ count: 1 });
    await system.messagingOutbound.update({
      where: { id: legacy.id },
      data: { providerHandle: "known-legacy-confirmation" },
    });
    const keys = [
      `command:stop:${identityId}:handle:opaque`,
      "command:leave:member",
      "command:approve:member",
      "command:decline:connection",
      "command:connected:connection",
      "link:used-code",
      `invite:channel:${identityId}`,
    ];
    for (const key of keys) {
      const receipt = await row(0, identityId, { sourceMessageId: null, idempotencyKey: key });
      expect(receipt.sourceBinding).toMatch(/^[a-f0-9]{64}$/);
    }
    const arbitrary = await row(0, identityId, {
      sourceMessageId: null,
      idempotencyKey: "arbitrary-output",
      sourceBinding: "forged",
    });
    expect(arbitrary.sourceBinding).toBeNull();
    const { messaging, sendToThread } = surface();
    await deliverMessagingOutbound(deliveryDeps(messaging), {}, context);
    expect(sendToThread).toHaveBeenCalledTimes(keys.length);
    expect(
      (await system.messagingOutbound.findUniqueOrThrow({ where: { id: arbitrary.id } })).status,
    ).toBe("retired");
    const obsolete = await row(0, identityId, {
      sourceMessageId: null,
      idempotencyKey: "link:old-target",
      body: "Private old bot name",
    });
    const binding = obsolete.sourceBinding;
    await retargetToAnotherSpace();
    expect(await claim(system, obsolete.id)).toEqual({ count: 0 });
    await system.messagingOutbound.update({
      where: { id: obsolete.id },
      data: { sourceBinding: "forged" },
    });
    expect(
      (await system.messagingOutbound.findUniqueOrThrow({ where: { id: obsolete.id } }))
        .sourceBinding,
    ).toBe(binding);
    await deliverMessagingOutbound(deliveryDeps(messaging), {}, context);
    expect(sendToThread).toHaveBeenCalledTimes(keys.length);
    expect(
      (await system.messagingOutbound.findUniqueOrThrow({ where: { id: obsolete.id } })).status,
    ).toBe("retired");
  });

  it("retires a confirmation that predates binding migration instead of inventing its source", async () => {
    const id = randomUUID();
    const admin = createPool(process.env.DATABASE_MIGRATION_URL!);
    const connection = await admin.connect();
    try {
      // Reproduce an already stored pre-migration row in this disposable database only.
      await connection.query("BEGIN");
      await connection.query(
        "ALTER TABLE messaging_outbound DISABLE TRIGGER messaging_outbound_delivery_protocol",
      );
      await connection.query(
        `INSERT INTO messaging_outbound (id, kind, "identityId", "idempotencyKey", body, status, "createdAt", "updatedAt")
        VALUES ($1, 'dm', $2, $3, 'Unproven historical bot name', 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, identityId, `link:${randomUUID()}`],
      );
      await connection.query(
        "ALTER TABLE messaging_outbound ENABLE TRIGGER messaging_outbound_delivery_protocol",
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
      await admin.end();
    }
    const { messaging, sendToThread } = surface();
    expect(await claim(system, id)).toEqual({ count: 0 });
    await deliverMessagingOutbound(deliveryDeps(messaging), {}, context);
    expect(sendToThread).not.toHaveBeenCalled();
    expect(await system.messagingOutbound.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "retired",
      sourceBinding: null,
    });
  });

  it("refuses a cached legacy final tail after its source was deleted while preserving valid legacy claims", async () => {
    const task = await system.task.create({
      data: { ...owner, prompt: "Cached final mirror", status: "running" },
    });
    const run = await system.run.create({
      data: { ...owner, taskId: task.id, trigger: "messaging", status: "running" },
    });
    await system.message.update({ where: { id: sourceMessageId }, data: { runId: run.id } });
    const prefix = await row(1);
    await newClaim(prefix.id);
    await system.messagingOutbound.update({
      where: { id: prefix.id },
      data: { providerHandle: "accepted-prefix" },
    });
    const source = await system.message.create({
      data: {
        threadId: owner.threadId,
        botId: owner.botId,
        runId: run.id,
        seq: 901,
        role: "bot",
        blocks: [{ kind: "text", text: "Cached private tail" }],
      },
    });
    const cached = { sourceMessageId: source.id, body: "Cached private tail" };
    await system.message.deleteMany({ where: { runId: run.id } });
    const tail = await row(0, identityId, cached);
    expect(tail.requiredDeliveryVersion).toBe(0);
    expect(await claim(system, tail.id)).toEqual({ count: 0 });
    const { messaging, sendToThread } = surface();
    await deliverMessagingOutbound(deliveryDeps(messaging), {}, context);
    expect(sendToThread).not.toHaveBeenCalled();
    expect(
      (await system.messagingOutbound.findUniqueOrThrow({ where: { id: tail.id } })).status,
    ).toBe("retired");
    const fresh = await system.message.create({
      data: {
        threadId: owner.threadId,
        botId: owner.botId,
        seq: 902,
        role: "bot",
        blocks: [{ kind: "text", text: "Valid legacy source" }],
      },
    });
    const valid = await row(0, identityId, { sourceMessageId: fresh.id });
    expect(await claim(system, valid.id)).toEqual({ count: 1 });
    await system.messagingOutbound.update({
      where: { id: valid.id },
      data: { providerHandle: "valid-accepted" },
    });
    const beforeRetarget = await row(0, identityId, { sourceMessageId: fresh.id });
    await retargetToAnotherSpace();
    expect(await claim(system, beforeRetarget.id)).toEqual({ count: 0 });
  });
});
