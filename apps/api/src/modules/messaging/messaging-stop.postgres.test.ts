// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { MessagingInboundMessage } from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  createThreadMessage,
  provisionMessagingIdentity,
  runAsSystem,
} from "@orkbot/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { STOPPED_BY_MESSAGE_NOTE } from "#modules/threads/thread-target";
import { createMessagingInboundHandler } from "./messaging-inbound.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

// Calls the inbound handler directly, as a provider retry on another instance reaches it:
// the Chat SDK's in-memory dedupe never sees the second delivery.
describe.skipIf(!enabled)("a linked owner's stop command (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let handle: (event: MessagingInboundMessage) => Promise<void>;
  let transaction: ReturnType<typeof vi.fn>;
  let channels: string[];
  let extraOwners: (typeof identity)[];
  const sandbox = {
    execute: vi.fn(async function* () {
      yield { type: "exit", code: 0 };
    }),
    releaseScreen: vi.fn().mockResolvedValue(undefined),
  };

  beforeAll(() => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
  });
  beforeEach(async () => {
    channels = [];
    extraOwners = [];
    identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "test", address: `stop-${randomUUID()}` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    transaction = vi.fn((...args: unknown[]) => Reflect.apply(prisma.$transaction, prisma, args));
    const inbound = createMessagingInboundHandler({
      prisma: new Proxy(prisma, {
        get: (target, key) => (key === "$transaction" ? transaction : Reflect.get(target, key)),
      }),
      events: createThreadEvents(prisma),
      jobs: { enqueue: vi.fn().mockResolvedValue(undefined) },
      sandbox: sandbox as never,
      provision: vi.fn(),
      openSignup: false,
      signupPolicy: { signupsEnabled: undefined, signupAllowlist: undefined },
    });
    handle = (event) => runAsSystem("test inbound", () => inbound(event));
  });
  afterEach(async () => {
    const channelRows = await system.messagingChannel.findMany({
      where: { id: { in: channels } },
      select: { threadId: true },
    });
    await system.messagingOutbound.deleteMany({
      where: { threadId: { in: channelRows.map((row) => row.threadId) } },
    });
    await system.messagingChannel.deleteMany({ where: { id: { in: channels } } });
    for (const extra of extraOwners) {
      await system.messagingIdentity.deleteMany({ where: { userId: extra.userId } });
      await system.organization.deleteMany({ where: { id: extra.spaceId } });
      await system.user.deleteMany({ where: { id: extra.userId } });
    }
    await system.messagingIdentity.deleteMany({ where: { userId: identity.userId } });
    await system.organization.deleteMany({ where: { id: identity.spaceId } });
    await system.user.deleteMany({ where: { id: identity.userId } });
  });
  afterAll(async () => {
    await close?.();
  });

  const text = (content: string, id: string, extra: Partial<MessagingInboundMessage> = {}) =>
    handle({
      type: "message",
      provider: "test",
      // Handles are unique per run: delivery receipts outlive the fixture.
      handle: `${identity.address}:${id}`,
      threadId: `dm-${identity.address}`,
      isDirect: true,
      from: identity.address,
      fromLabel: null,
      channelName: null,
      participants: [],
      content,
      mediaUrl: null,
      ...extra,
    });
  const work = async (channelId?: string, secondChannelId?: string, person = identity) => {
    const owner = {
      spaceId: person.spaceId,
      botId: person.botId,
      threadId: person.threadId,
      userId: person.userId,
    };
    const task = await system.task.create({ data: { ...owner, prompt: "work", status: "queued" } });
    const source = channelId
      ? await createThreadMessage(system, {
          threadId: person.threadId,
          role: "user",
          blocks: [channelId, ...(secondChannelId ? [secondChannelId] : [])].map((id) => ({
            kind: "channel_message",
            channelId: id,
            provider: "test",
            text: "work",
            fromAddress: person.address,
            fromLabel: "Owner",
            hop: 0,
          })),
        })
      : null;
    return system.run.create({
      data: {
        ...owner,
        taskId: task.id,
        status: "running",
        trigger: "user",
        sourceMessageId: source?.id,
      },
    });
  };
  const status = async (id: string) =>
    (await system.run.findUniqueOrThrow({ where: { id } })).status;
  const runs = () => system.run.count({ where: { botId: identity.botId } });
  const replies = async () =>
    (
      await system.messagingOutbound.findMany({
        where: {
          identityId: (
            await system.messagingIdentity.findFirstOrThrow({ where: { botId: identity.botId } })
          ).id,
        },
      })
    ).map((row) => row.body);
  const notes = async () =>
    (
      await system.message.findMany({ where: { threadId: identity.threadId, role: "system" } })
    ).filter((message) => JSON.stringify(message.blocks).includes(STOPPED_BY_MESSAGE_NOTE)).length;
  const userMessages = () =>
    system.message.count({ where: { threadId: identity.threadId, role: "user" } });

  const channel = async (status = "approved") => {
    const linked = await system.messagingIdentity.findFirstOrThrow({
      where: { botId: identity.botId },
    });
    const channel = await system.messagingChannel.create({
      data: {
        provider: "test",
        threadId: `group-${randomUUID()}`,
        members: { create: { address: identity.address, identityId: linked.id, status } },
      },
    });
    channels.push(channel.id);
    return channel;
  };
  const groupText = (
    group: { threadId: string },
    content: string,
    id: string,
    extra: Partial<MessagingInboundMessage> = {},
  ) =>
    text(content, id, {
      isDirect: false,
      threadId: group.threadId,
      participants: [],
      ...extra,
    });

  it("stops only this approved channel's work and keeps a concurrent replay stable", async () => {
    const group = await channel();
    const other = await channel();
    const current = await work(group.id);
    const dm = await work();
    const unrelated = await work(other.id, group.id);
    await Promise.all([
      groupText(group, "zatrzymaj", "channel-stop"),
      groupText(group, "zatrzymaj", "channel-stop"),
    ]);
    expect(await status(current.id)).toBe("cancelled");
    expect(await status(dm.id)).toBe("running");
    expect(await status(unrelated.id)).toBe("running");
    expect(await userMessages()).toBe(2);
    const newer = await work(group.id);
    await groupText(group, "zatrzymaj", "channel-stop");
    expect(await status(newer.id)).toBe("running");
    expect(await replies()).toEqual([]);
    expect(await notes()).toBe(1);
    expect(
      await system.messagingOutbound.findMany({ where: { threadId: group.threadId } }),
    ).toEqual([
      expect.objectContaining({ kind: "command_receipt", status: "recorded", body: "stopped" }),
    ]);
  });

  it("stops approved member bots across owners while leaving unapproved bots alone", async () => {
    const group = await channel();
    const peers = await Promise.all(
      ["approved", "invited"].map(async (status) => {
        const peer = await runAsSystem("channel stop peer fixture", () =>
          provisionMessagingIdentity(
            prisma,
            { provider: "test", address: `peer-${randomUUID()}` },
            { signupsEnabled: undefined, signupAllowlist: undefined },
          ),
        );
        extraOwners.push(peer);
        const linked = await system.messagingIdentity.findFirstOrThrow({
          where: { botId: peer.botId },
        });
        await system.messagingChannelMember.create({
          data: {
            channelId: group.id,
            address: peer.address,
            identityId: linked.id,
            status,
          },
        });
        return work(group.id, undefined, peer);
      }),
    );
    const own = await work(group.id);
    await groupText(group, "stop", "channel-multiple-owners");
    expect(await status(own.id)).toBe("cancelled");
    expect(await status(peers[0]!.id)).toBe("cancelled");
    expect(await status(peers[1]!.id)).toBe("running");
  });

  it("fans an idle stop out normally and never cancels later work on retry", async () => {
    const group = await channel();
    await groupText(group, "stop", "channel-idle");
    expect(await userMessages()).toBe(1);
    const newer = await work(group.id);
    await groupText(group, "stop", "channel-idle");
    expect(await status(newer.id)).toBe("running");
    expect(await userMessages()).toBe(2); // source fixture plus the original stop
    expect(await replies()).toEqual([]);
  });

  it.each([
    { name: "bot sender", extra: { senderIsBot: true } },
    { name: "media", extra: { mediaUrl: "https://example.test/image.jpg" } },
    {
      name: "attachment",
      extra: {
        attachments: [
          { name: "image.jpg", mimeType: "image/jpeg", fetch: async () => new Uint8Array() },
        ],
      },
    },
    { name: "different provider", extra: { provider: "other" } },
  ])("keeps active work for $name", async ({ extra }) => {
    const group = await channel();
    const current = await work(group.id);
    await groupText(group, "stop", "channel-no-stop", extra);
    expect(await status(current.id)).toBe("running");
  });

  it("requires an approved linked sender", async () => {
    const group = await channel("invited");
    const current = await work(group.id);
    await groupText(group, "stop", "channel-unapproved");
    expect(await status(current.id)).toBe("running");
    await system.messagingChannelMember.updateMany({
      where: { channelId: group.id },
      data: { status: "approved" },
    });
    await system.messagingIdentity.deleteMany({ where: { botId: identity.botId } });
    await groupText(group, "stop", "channel-unlinked");
    expect(await status(current.id)).toBe("running");
  });

  it("stops running work, answers once and notes it in the app", async () => {
    const running = await work();
    await text("stop", "h-stop");
    expect(await status(running.id)).toBe("cancelled");
    expect([await replies(), await notes()]).toEqual([[STOPPED_BY_MESSAGE_NOTE], 1]);
    // The stop locks the thread row, which snapshot reads hold for up to 15s.
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 20_000 });
  });

  it("tears down the stopped run's computer work, as Stop does", async () => {
    const running = await work();
    const computer = await system.computer.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        scopeKey: `stop-${running.id}`,
        homeKey: `stop-${running.id}`,
        kind: "fake",
        state: "running",
        providerRef: `ref-${running.id}`,
      },
    });
    const lease = await system.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: identity.botId,
        runId: running.id,
        fence: 3,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await text("stop", "h-computer");
    expect(sandbox.execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: `ref-${running.id}` }),
      expect.objectContaining({
        argv: expect.arrayContaining(["orkbot-cancel-run-work", computer.id, running.id]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: running.id }),
    );
    expect(sandbox.releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: `ref-${running.id}` }),
      expect.objectContaining({ runId: running.id, screenLeaseId: `${running.id}:3` }),
    );
    expect(
      (
        await system.computerExecutionLease.findUniqueOrThrow({ where: { id: lease.id } })
      ).expiresAt.getTime(),
    ).toBeLessThanOrEqual(Date.now());
  });

  it("answers an idle stop without a message, a turn or a routine wake", async () => {
    await system.routine.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId: identity.botId,
        name: "Replies",
        prompt: "Answer the message",
        crons: [],
        messageProvider: "test",
        active: true,
      },
    });
    await text("Stop now!", "h-idle");
    expect([await runs(), await userMessages(), await notes()]).toEqual([0, 0, 0]);
    expect(await replies()).toEqual(["Nothing is running."]);
  });

  it("leaves work started after a stop alone when that stop is delivered again", async () => {
    const first = await work();
    await text("stop", "h-again");
    expect(await status(first.id)).toBe("cancelled");
    const newer = await work();
    await text("stop", "h-again");
    expect(await status(newer.id)).toBe("running");
    expect(await replies()).toEqual([STOPPED_BY_MESSAGE_NOTE]);
  });

  it("leaves work started after an idle stop alone when it is delivered again", async () => {
    await text("stop", "h-idle-again");
    const newer = await work();
    await text("stop", "h-idle-again");
    expect(await status(newer.id)).toBe("running");
    expect(await replies()).toEqual(["Nothing is running."]);
  });

  it("stops once when two copies arrive together", async () => {
    const running = await work();
    await Promise.all([text("stop", "h-twice"), text("stop", "h-twice")]);
    expect(await status(running.id)).toBe("cancelled");
    expect([await replies(), await notes()]).toEqual([[STOPPED_BY_MESSAGE_NOTE], 1]);
  });

  it("delivers a stop that carries a file as a message", async () => {
    const running = await work();
    await text("stop", "h-file", {
      attachments: [
        { name: "photo.jpg", mimeType: "image/jpeg", fetch: async () => new Uint8Array() },
      ],
    });
    expect(await status(running.id)).toBe("running");
    expect(await userMessages()).toBe(1);
    expect(await replies()).toEqual([]);
  });

  it("treats a stop in a group chat as an ordinary message", async () => {
    const running = await work();
    await text("stop", "h-group", {
      isDirect: false,
      threadId: `group-${identity.address}`,
      participants: [identity.address, "someone-else"],
    });
    expect(await status(running.id)).toBe("running");
    // The group is new, so its only DM is the invitation to join it.
    expect(await replies()).not.toContain(STOPPED_BY_MESSAGE_NOTE);
    expect(await replies()).not.toContain("Nothing is running.");
  });
});
